import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import relay from '../cloud/coordinator.js';
import {observeFlow} from '../cloud/flow.js';
import {RemoteBrowser} from '../src/remote-browser.js';
import {CatalogDB} from '../src/db.js';

async function fixture(t){
 const sql=new DatabaseSync(':memory:');sql.exec(await fs.readFile(new URL('../cloud/migrations/0001_relay.sql',import.meta.url),'utf8'));t.after(()=>sql.close());
 const store=new Map();
 const env={CLIENT_TOKEN:'private-client-test',WORKER_TOKEN:'private-worker-test',
  DB:{prepare(query){let args=[];return {bind(...v){args=v;return this;},async first(){return sql.prepare(query).get(...args)||null;},async all(){return {results:sql.prepare(query).all(...args)};},async run(){return sql.prepare(query).run(...args);}};}},
  SHOTS:{async put(key,value){store.set(key,new Uint8Array(await new Response(value).arrayBuffer()));},async get(key){const b=store.get(key);return b?{body:new Blob([b]).stream(),json:async()=>JSON.parse(new TextDecoder().decode(b))}:null;}}
 };
 async function call(route,body,worker=false,method=body?'POST':'GET'){
  const multipart=body instanceof FormData;
  const request=new Request('https://relay.test'+route,{method,headers:{Authorization:'Bearer '+(worker?env.WORKER_TOKEN:env.CLIENT_TOKEN),...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined});
  const response=await relay.fetch(request,env);return {response,data:response.headers.get('content-type')?.includes('json')?await response.json():await response.arrayBuffer()};
 }
 const submit=(id='job-1',affinity=null)=>call('/commands',{id,clientId:'pc-1',affinity,payload:{op:'prepare',task:{id:1,url:'https://www.pragmaticplay.fun/en/slots/candy-rush/'},lineage:[]}});
 const beat=(workerId='w-1')=>call('/worker/heartbeat',{workerId,clientId:'pc-1',capacity:8,active:0,live:[1]},true);
 return {sql,store,call,submit,beat};
}
test('repeated submission has one immutable identity and two workers cannot both claim it',async t=>{
 const f=await fixture(t);assert.equal((await f.submit()).response.status,201);assert.equal((await f.submit()).data.id,'job-1');
 assert.equal(f.sql.prepare('SELECT count(*) AS n FROM commands').get().n,1);
 const changed=await f.call('/commands',{id:'job-1',clientId:'pc-1',payload:{op:'release',taskId:1}});assert.equal(changed.response.status,409);
 await f.beat('w-1');await f.beat('w-2');
 const claims=await Promise.all(['w-1','w-2'].map(workerId=>f.call('/worker/claim',{workerId,clientId:'pc-1',allowNew:true},true)));
 assert.equal(claims.filter(r=>r.data.command).length,1);
});
test('a live continuation goes only to its original worker, even when another is free',async t=>{
 const f=await fixture(t);await f.beat('w-1');await f.beat('w-2');await f.submit('live','w-1');
 assert.equal((await f.call('/worker/claim',{workerId:'w-2',clientId:'pc-1',allowNew:true},true)).data.command,null);
 const row=(await f.call('/worker/claim',{workerId:'w-1',clientId:'pc-1',allowNew:false},true)).data.command;assert.equal(row.id,'live');
});
test('start is single use and result persists before an authenticated image download',async t=>{
 const f=await fixture(t);await f.beat();await f.submit();
 const c=(await f.call('/worker/claim',{workerId:'w-1',clientId:'pc-1',allowNew:true},true)).data.command,identity={workerId:'w-1',token:c.token};
 assert.equal((await f.call('/worker/job-1/start',identity,true)).response.status,200);
 assert.equal((await f.call('/worker/job-1/start',identity,true)).response.status,409);
 const form=new FormData();form.set('metadata',JSON.stringify({...identity,result:{live:true,capture:{state:'BONUS'}}}));form.set('image',new Blob([new Uint8Array([255,216,255,217])],{type:'image/jpeg'}),'shot.jpg');
 assert.equal((await f.call('/worker/job-1/complete',form,true)).response.status,200);
 const result=await f.call('/commands/job-1?clientId=pc-1');assert.equal(result.data.state,'done');assert.equal(result.data.result.capture.state,'BONUS');
 assert.equal((await f.call('/commands/job-1/image?clientId=pc-1')).data.byteLength,4);
 assert.equal((await f.call('/commands/job-1/image?clientId=another')).response.status,404);
 assert.equal((await f.call('/worker/job-1/start',identity,false)).response.status,401);
});
test('a dead worker leaves an uncertain command and polling cannot replay its purchase',async t=>{
 const f=await fixture(t);await f.beat();await f.submit();
 const c=(await f.call('/worker/claim',{workerId:'w-1',clientId:'pc-1',allowNew:true},true)).data.command;
 await f.call('/worker/job-1/start',{workerId:'w-1',token:c.token},true);
 f.sql.prepare('UPDATE commands SET lease_until=0').run();
 assert.equal((await f.call('/commands/job-1?clientId=pc-1')).data.state,'uncertain');
 assert.equal((await f.call('/worker/claim',{workerId:'w-1',clientId:'pc-1',allowNew:true},true)).data.command,null);
});
test('stop is cooperative and heartbeat conveys it to the exact client fleet',async t=>{
 const f=await fixture(t);await f.beat();await f.call('/fleet/stop',{clientId:'pc-1'});assert.equal((await f.beat()).data.stop,true);
});
test('starting a bonus and displaying its award are not completed purchases',()=>{
 const flow={purchasePending:true},button=path=>({path,hit:{x:0,y:0,w:1,h:1}});
 assert.equal(observeFlow(flow,{state:'BONUS',controls:[button('Game/FSWindows/FSStart/ButtonContinue')]}).terminalPurchase,false);
 assert.equal(observeFlow(flow,{state:'BONUS',controls:[button('Game/FSWindows/FSResult/ButtonContinue')]}).phase,'result');
 assert.equal(observeFlow(flow,{state:'BASE',controls:[button('Game/SpinButtons/StopSpin_Button')]}).terminalPurchase,false);
 assert.equal(observeFlow(flow,{state:'BASE',controls:[button('Game/SpinButtons/StartSpin_Button')]}).terminalPurchase,true);
});
test('remote preparation downloads a JPEG on the PC and does not launch a local browser',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-pc-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const requests=[],client={clientId:'pc-1',submit:async(...args)=>requests.push(args),read:async()=>({state:'done',workerId:'w-1',result:{live:true,capture:{state:'BONUS'}}}),call:async()=>new Response(new Uint8Array([255,216,255,217]))};
 const db={getTask:()=>null,lineage:()=>[]};const browser=new RemoteBrowser({dataDir:dir},db,{client});
 const r=await browser.prepare({id:42,url:'https://www.pragmaticplay.fun/en/slots/candy-rush/'});
 assert.equal((await fs.readFile(r.file)).length,4);assert.equal(r.capture.remoteWorker,'w-1');assert.equal(requests[0][0],'pc-1:task:42');assert.equal(requests[1][1].waitSeconds,60);assert.equal(requests[1][2],'w-1');assert.equal(r.capture.initialLoadWaitApplied,true);
});
test('the local registry counts a cloud purchase only after the result was closed',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-proof-')),db=new CatalogDB(dir);t.after(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});
 db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);
 const ready=(id,state,phase,terminal=false)=>{db.claim(id);db.ready(id,{capture_file:'proof.jpg',capture:{state,controls:[],flowCompletion:{version:1,phase,purchasePending:phase!=='idle',terminalPurchase:terminal}}});};
 ready(1,'BASE','idle');const buy=db.commit(1,[{x:.2,y:.2,kind:'buy'}]).children[0].taskId;
 ready(buy,'CONFIRM','confirmation');assert.equal(db.gameProgress()[0].purchases.completed,0);
 const confirm=db.commit(buy,[{x:.5,y:.5,kind:'confirm'}]).children[0].taskId;
 ready(confirm,'BONUS','result');assert.equal(db.gameProgress()[0].purchases.completed,0);
 const close=db.commit(confirm,[{x:.5,y:.5,kind:'continue'}]).children[0].taskId;
 ready(close,'BASE','completed',true);assert.equal(db.gameProgress()[0].purchases.completed,1);
});


test('waiting for a live screenshot preserves worker affinity and sends no click',async()=>{
 const sent=[],client={clientId:'pc-1',submit:async(...args)=>sent.push(args)};
 const browser=new RemoteBrowser({}, {}, {client});browser.workers=[{id:'w-1',live:[9]}];
 browser.waitForResult=async()=>({ok:true});
 await browser.refresh({id:9,parent_task_id:2,capture_json:JSON.stringify({remoteWorker:'w-1'})},{waitSeconds:30});
 assert.equal(sent[0][1].op,'observe');assert.equal(sent[0][1].waitSeconds,30);assert.equal(sent[0][2],'w-1');assert.equal(sent[0][1].rootTask,undefined);
 await assert.rejects(()=>browser.refresh({id:9},{waitSeconds:61}),/espera/);
});
test('archived initial screenshots may reopen but a lost purchase session is never replayed',async()=>{
 const sent=[],client={clientId:'pc-1',submit:async(...args)=>sent.push(args)};
 const browser=new RemoteBrowser({}, {}, {client});browser.workers=[{id:'w-2',live:[]}];browser.waitForResult=async()=>({});
 await browser.refresh({id:4,parent_task_id:null,url:'https://demo.example/game'},{waitSeconds:10});
 assert.equal(sent[0][1].rootTask.id,4);assert.equal(sent[0][2],null);
 await assert.rejects(()=>browser.refresh({id:5,parent_task_id:4}),/No se repiten/);assert.equal(sent.length,1);
});

test('recapturing a ready task replaces its timestamp and worker without requeueing',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'cloud-refresh-')),db=new CatalogDB(dir);t.after(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});
 db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);db.claim(1);db.ready(1,{capture_file:'old.jpg',capture:{capturedAt:'old',remoteWorker:'old-worker'}});
 db.refreshReady(1,{file:'new.jpg',capture:{capturedAt:'new',remoteWorker:'new-worker'}});
 const task=db.getTask(1);assert.equal(task.status,'ready');assert.equal(task.capture_file,'new.jpg');assert.equal(JSON.parse(task.capture_json).remoteWorker,'new-worker');
 db.finish(1);assert.throws(()=>db.refreshReady(1,{file:'oops',capture:{}}),/clasificada/);
});
