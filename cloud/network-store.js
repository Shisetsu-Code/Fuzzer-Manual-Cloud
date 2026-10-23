const valid=v=>typeof v==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(v);
const json=(v,s=200)=>Response.json(v,{status:s,headers:{'Cache-Control':'no-store'}});
const sha=async b=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',b)),v=>v.toString(16).padStart(2,'0')).join('');
async function read(request,max){const reader=request.body?.getReader(),chunks=[];let n=0;if(!reader)throw Error('Body required');for(;;){const r=await reader.read();if(r.done)break;n+=r.value.length;if(n>max){await reader.cancel();throw Error('Network archive too large');}chunks.push(r.value);}const out=new Uint8Array(n);let p=0;for(const c of chunks){out.set(c,p);p+=c.length;}return out;}
export async function networkRoute(request,env){
 const u=new URL(request.url),upload=u.pathname.match(/^\/worker\/network\/([\w.:-]+)\/(part\/(\d+)|complete)$/),download=u.pathname.match(/^\/network\/([\w.:-]+)\/(manifest|part\/(\d+))$/);
 if(upload&&request.method==='POST'){
  const clientId=request.headers.get('X-Client-Id'),workerId=request.headers.get('X-Worker-Id');if(!valid(clientId)||!valid(workerId)||!valid(upload[1]))throw Error('Invalid archive identity');
  const worker=await env.DB.prepare('SELECT id FROM workers WHERE id=? AND client_id=? AND heartbeat>?').bind(workerId,clientId,Date.now()-120000).first();if(!worker)return json({error:'Live archive worker required'},403);
  const base=`network/${clientId}/${upload[1]}`;
  if(upload[3]!==undefined){const index=Number(upload[3]);if(index>2047)throw Error('Too many archive parts');const data=await read(request,4*1024*1024);const digest=await sha(data);if(digest!==request.headers.get('X-Content-SHA256'))throw Error('Archive checksum mismatch');
   await env.SHOTS.put(`${base}/part-${index}`,data,{customMetadata:{sha256:digest,size:String(data.length)}});return json({ok:true});}
  const manifest=JSON.parse(new TextDecoder().decode(await read(request,1024*1024)));if(!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>2048)throw Error('Invalid archive manifest');
  for(let i=0;i<manifest.parts.length;i++){const part=manifest.parts[i],saved=await env.SHOTS.head(`${base}/part-${i}`);if(!saved||saved.customMetadata?.sha256!==part.sha256||Number(saved.customMetadata?.size)!==part.size)throw Error('Archive part missing or corrupt');}
  const saved={schemaVersion:1,id:upload[1],workerId,clientId,createdAt:new Date().toISOString(),parts:manifest.parts,metadata:manifest.metadata||{}};
  await env.SHOTS.put(`network/${clientId}/manifests/${upload[1]}.json`,JSON.stringify(saved),{httpMetadata:{contentType:'application/json'}});return json({ok:true,id:upload[1]});
 }
 if((u.pathname==='/network'||download)&&request.method==='GET'){
  const clientId=u.searchParams.get('clientId');if(!valid(clientId))throw Error('Invalid archive client');
  if(!download){const listed=await env.SHOTS.list({prefix:`network/${clientId}/manifests/`,limit:1000,cursor:u.searchParams.get('cursor')||undefined});const items=[];for(const object of listed.objects){const item=await env.SHOTS.get(object.key);if(item)items.push(await item.json());}return json({items,cursor:listed.truncated?listed.cursor:null});}
  if(!valid(download[1]))throw Error('Invalid archive');const manifest=await env.SHOTS.get(`network/${clientId}/manifests/${download[1]}.json`);if(!manifest)return json({error:'Archive not found'},404);
  if(download[2]==='manifest')return json(await manifest.json());const data=await manifest.json(),index=Number(download[3]);if(!Number.isInteger(index)||!data.parts[index])return json({error:'Part not found'},404);
  const part=await env.SHOTS.get(`network/${clientId}/${download[1]}/part-${index}`);if(!part)return json({error:'Part not found'},404);return new Response(part.body,{headers:{'Content-Type':'application/octet-stream','Cache-Control':'no-store'}});
 }
 return null;
}
