const enc=new TextEncoder();
const json=(value,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const validId=s=>typeof s==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(s);
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
async function authorized(request,secret){
 if(!secret)return false;
 const provided=request.headers.get('Authorization')?.replace(/^Bearer /,'')||'';
 const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);
 const signature=await crypto.subtle.sign('HMAC',key,enc.encode(provided));
 return crypto.subtle.verify('HMAC',key,signature,enc.encode(secret));
}
async function bytes(request,max){
 const reader=request.body?.getReader(),parts=[];let size=0;
 if(!reader)throw Error('Body required');
 while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>max){await reader.cancel();throw Error('Request too large');}parts.push(value);}
 const out=new Uint8Array(size);let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;
}
async function body(request){return JSON.parse(new TextDecoder().decode(await bytes(request,1024*1024)));}
async function command(env,id){return env.DB.prepare('SELECT * FROM commands WHERE id=?').bind(id).first();}
async function expire(env,clientId,now){
 await env.DB.prepare("UPDATE commands SET state='uncertain',error='Worker lease expired; no automatic replay',updated=? WHERE client_id=? AND state IN ('claimed','started') AND lease_until<?").bind(now,clientId,now).run();
 await env.DB.prepare("UPDATE commands SET state='uncertain',error='LIVE_SESSION_LOST',updated=? WHERE client_id=? AND state='queued' AND affinity IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workers WHERE workers.id=commands.affinity AND heartbeat>?)").bind(now,clientId,now-90000).run();
}
async function owned(env,id,v){
 const row=await command(env,id);
 if(!row||row.owner!==v.workerId||row.token!==v.token||!['claimed','started'].includes(row.state)||row.lease_until<Date.now())throw Error('Stale execution ownership');
 return row;
}
export async function route(request,env){
 const u=new URL(request.url),p=u.pathname,now=Date.now();
 if(p==='/health'&&request.method==='GET')return json({ok:true,service:'fuzzer-manual-cloud',protocol:1});
 const workerRoute=p.startsWith('/worker/');
 if(!await authorized(request,workerRoute?env.WORKER_TOKEN:env.CLIENT_TOKEN))return json({error:'Unauthorized'},401);
 if(p==='/commands'&&request.method==='POST'){
  const v=await body(request);
  if(!validId(v.id)||!validId(v.clientId)||v.affinity!=null&&!validId(v.affinity)||!v.payload||!['prepare','release','observe'].includes(v.payload.op))throw Error('Invalid command');
  const bytes=enc.encode(JSON.stringify(v.payload)),digest=await hash(bytes),old=await command(env,v.id);
  if(old)return old.client_id===v.clientId&&old.payload_hash===digest?json({id:old.id,state:old.state}):json({error:'Command identity conflict'},409);
  if(v.affinity){const w=await env.DB.prepare('SELECT heartbeat FROM workers WHERE id=? AND client_id=?').bind(v.affinity,v.clientId).first();
   if(!w||w.heartbeat<now-90000)return json({error:'LIVE_SESSION_LOST: el worker original ya no está disponible'},409);
  }
  const key=`commands/${v.clientId}/${v.id}/${digest}.json`;
  await env.SHOTS.put(key,bytes,{httpMetadata:{contentType:'application/json'}});
  await env.DB.prepare("INSERT OR IGNORE INTO commands(id,client_id,payload_key,payload_hash,affinity,created,updated) VALUES(?,?,?,?,?,?,?)").bind(v.id,v.clientId,key,digest,v.affinity||null,now,now).run();
  const saved=await command(env,v.id);if(saved.payload_hash!==digest||saved.client_id!==v.clientId)return json({error:'Command identity conflict'},409);
  return json({id:v.id,state:saved.state},201);
 }
 if(p==='/workers'&&request.method==='GET'){
  const clientId=u.searchParams.get('clientId');if(!validId(clientId))throw Error('Invalid client');
  const rows=await env.DB.prepare('SELECT id,capacity,active,live_json,heartbeat FROM workers WHERE client_id=? AND heartbeat>?').bind(clientId,now-90000).all();
  return json({workers:rows.results.map(w=>({...w,live:JSON.parse(w.live_json),live_json:undefined}))});
 }
 if(p==='/fleet/stop'&&request.method==='POST'){
  const v=await body(request);if(!validId(v.clientId))throw Error('Invalid client');
  await env.DB.prepare('UPDATE workers SET stop_requested=1 WHERE client_id=?').bind(v.clientId).run();return json({ok:true});
 }
 const read=p.match(/^\/commands\/([a-zA-Z0-9_.:-]+)(\/image)?$/);
 if(read&&request.method==='GET'){
  await expire(env,u.searchParams.get('clientId'),now);
  const row=await command(env,read[1]);if(!row||row.client_id!==u.searchParams.get('clientId'))return json({error:'Not found'},404);
  if(!read[2]){
   const result=row.result_key?await env.SHOTS.get(row.result_key):null;
   return json({id:row.id,state:row.state,workerId:row.owner,error:row.error,result:result?await result.json():null});
  }
  const image=row.image_key?await env.SHOTS.get(row.image_key):null;if(!image)return json({error:'Image not ready'},404);
  return new Response(image.body,{headers:{'Content-Type':'image/jpeg','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'}});
 }
 if(p==='/worker/heartbeat'&&request.method==='POST'){
  const v=await body(request);if(!validId(v.workerId)||!validId(v.clientId)||!Number.isInteger(v.capacity)||v.capacity<1||v.capacity>8||!Array.isArray(v.live)||v.live.length>8)throw Error('Invalid worker');
  await env.DB.prepare("INSERT INTO workers(id,client_id,capacity,active,live_json,heartbeat) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET active=excluded.active,live_json=excluded.live_json,heartbeat=excluded.heartbeat").bind(v.workerId,v.clientId,v.capacity,Number(v.active)||0,JSON.stringify(v.live),now).run();
  await env.DB.prepare("UPDATE commands SET lease_until=?,updated=? WHERE owner=? AND client_id=? AND state IN ('claimed','started') AND lease_until>?").bind(now+120000,now,v.workerId,v.clientId,now).run();
  const saved=await env.DB.prepare('SELECT stop_requested FROM workers WHERE id=?').bind(v.workerId).first();
  return json({ok:true,stop:!!saved.stop_requested});
 }
 if(p==='/worker/claim'&&request.method==='POST'){
  const v=await body(request);if(!validId(v.workerId)||!validId(v.clientId))throw Error('Invalid identity');
  const w=await env.DB.prepare('SELECT * FROM workers WHERE id=? AND client_id=? AND heartbeat>?').bind(v.workerId,v.clientId,now-90000).first();if(!w)throw Error('Worker heartbeat required');
  // A lost claim may have clicked. It is never placed back on the queue.
  await env.DB.prepare("UPDATE commands SET state='uncertain',error='Worker lease expired; no automatic replay',updated=? WHERE client_id=? AND state IN ('claimed','started') AND lease_until<?").bind(now,v.clientId,now).run();
  await env.DB.prepare("UPDATE commands SET state='uncertain',error='LIVE_SESSION_LOST',updated=? WHERE client_id=? AND state='queued' AND affinity IS NOT NULL AND NOT EXISTS(SELECT 1 FROM workers WHERE workers.id=commands.affinity AND heartbeat>?)").bind(now,v.clientId,now-90000).run();
  const token=crypto.randomUUID();
  const row=await env.DB.prepare("UPDATE commands SET state='claimed',owner=?,token=?,lease_until=?,updated=? WHERE id=(SELECT id FROM commands WHERE client_id=? AND state='queued' AND (affinity=? OR (affinity IS NULL AND ?=1)) ORDER BY affinity IS NULL,created LIMIT 1) AND state='queued' RETURNING *").bind(v.workerId,token,now+120000,now,v.clientId,v.workerId,v.allowNew===true?1:0).first();
  if(!row)return json({command:null});
  const payload=await env.SHOTS.get(row.payload_key);if(!payload)throw Error('Command payload unavailable');
  return json({command:{id:row.id,token,payload:await payload.json()}});
 }
 const action=p.match(/^\/worker\/([a-zA-Z0-9_.:-]+)\/(start|complete|fail)$/);
 if(action&&request.method==='POST'){
  const v=action[2]==='complete'?null:await body(request);
  if(action[2]==='complete'){
   const raw=await bytes(request,9*1024*1024);
   const form=await new Response(raw,{headers:{'Content-Type':request.headers.get('Content-Type')}}).formData(),meta=JSON.parse(form.get('metadata'));
   const row=await owned(env,action[1],meta);if(row.state!=='started')throw Error('Command not started');
   const image=form.get('image');if(image&&image.size>8*1024*1024)throw Error('Image too large');
   const key=`results/${row.client_id}/${row.id}/${row.token}`;
   if(image)await env.SHOTS.put(key+'.jpg',image.stream(),{httpMetadata:{contentType:'image/jpeg'}});
   await env.SHOTS.put(key+'.json',JSON.stringify(meta.result),{httpMetadata:{contentType:'application/json'}});
   const updated=await env.DB.prepare("UPDATE commands SET state='done',result_key=?,image_key=?,updated=? WHERE id=? AND token=? AND state='started' AND lease_until>? RETURNING id").bind(key+'.json',image?key+'.jpg':null,Date.now(),row.id,row.token,Date.now()).first();
   if(!updated)throw Error('Completion ownership expired');return json({ok:true});
  }
  const row=await owned(env,action[1],v);
  if(action[2]==='start'){
   const updated=await env.DB.prepare("UPDATE commands SET state='started',updated=? WHERE id=? AND token=? AND state='claimed' RETURNING id").bind(now,row.id,row.token).first();
   if(!updated)return json({error:'Already started; do not execute again'},409);return json({ok:true});
  }
  await env.DB.prepare("UPDATE commands SET state=?,error=?,updated=? WHERE id=? AND token=? AND state IN ('claimed','started')").bind(row.state==='started'?'uncertain':'failed',String(v.error||'Execution failed').slice(0,300),now,row.id,row.token).run();return json({ok:true});
 }
 return json({error:'Not found'},404);
}
export default {async fetch(request,env){try{return await route(request,env);}catch(e){console.error(JSON.stringify({event:'relay_error',message:String(e.message).slice(0,180)}));return json({error:String(e.message).slice(0,300)},400);}}};
