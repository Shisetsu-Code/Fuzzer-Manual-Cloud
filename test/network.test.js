import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {gunzipSync} from 'node:zlib';
import {CatalogDB} from '../src/db.js';
import {buildReplayPlan} from '../src/replay-plan.js';
import {NetworkClient} from '../src/network-client.js';
import {uploadNetwork} from '../cloud/network-upload.mjs';
import {networkRoute} from '../cloud/network-store.js';
import {replayRoute} from '../cloud/replay-route.mjs';
import {ReplayManager} from '../src/replay-manager.js';
import {RemoteBrowser} from '../src/remote-browser.js';

async function directory(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fm-network-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}).catch(()=>{}));return dir;}
function storage(){const objects=new Map();return {async put(key,value,options={}){objects.set(key,{bytes:new Uint8Array(await new Response(value).arrayBuffer()),...options});},async head(key){return objects.get(key)||null;},async get(key){const item=objects.get(key);return item?{...item,body:new Blob([item.bytes]).stream(),json:async()=>JSON.parse(new TextDecoder().decode(item.bytes))}:null;},async list({prefix}){return {objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false};}};}

test('saved branches and ordered clicks form a read-only reconstruction plan',async t=>{
 const dir=await directory(t),db=new CatalogDB(dir);t.after(async()=>{db.close();await fs.rm(dir,{recursive:true,force:true});});db.importUrls(['https://www.pragmaticplay.fun/en/slots/test/']);
 db.claim(1);db.ready(1,{capture_file:'root',capture:{state:'BUY_MENU',visualKey:'saved'}});
 const branches=db.commit(1,[{x:.2,y:.3},{x:.4,y:.5}]).children;
 const child=branches[0].taskId;db.claim(child);db.ready(child,{capture_file:'child',capture:{state:'BASE'}});
 db.commit(child,[{x:.7,y:.8,kind:'ordered'},{x:.9,y:.8,kind:'ordered'}]);
 const before=JSON.stringify(db.db.prepare('SELECT * FROM tasks').all()),plan=buildReplayPlan(db,'job');
 assert.equal(plan.gameCount,1);assert.equal(plan.routeCount,2);assert.equal(plan.actionCount,3);
 const sequence=plan.routes.find(route=>route.steps.length===2).steps[1].mark;assert.equal(sequence.kind,'sequence');assert.deepEqual(sequence.steps.map(m=>m.x),[.7,.9]);
 assert.equal(JSON.stringify(db.db.prepare('SELECT * FROM tasks').all()),before);
});

test('private HAR upload and PC download retain full request and response payloads',async t=>{
 const dir=await directory(t),source=path.join(dir,'source.har'),body=JSON.stringify({log:{version:'1.2',entries:[{request:{method:'POST',url:'https://demo.test/spin?game=42',postData:{text:'{"bet":3}'}},response:{content:{text:'{"win":9}'}}}]}});await fs.writeFile(source,body);
 const env={SHOTS:storage(),DB:{prepare(){return {bind(){return this;},first:async()=>({id:'worker'})};}}};
 const fetcher=async(url,options)=>networkRoute(new Request(url,options),env);
 const uploaded=await uploadNetwork(source,{kind:'har',gameId:42},{endpoint:'https://relay.test',token:'test',workerId:'worker',clientId:'pc',fetcher});
 const client={clientId:'pc',call:async(route,{raw=false}={})=>{const response=await fetcher('https://relay.test'+route);if(!response.ok)throw Error('HTTP '+response.status);return raw?response:response.json();}};
 const network=new NetworkClient({dataDir:dir},client);await network.start();await network.sync();assert.equal(network.error,null);assert.equal(network.items.size,1);
 assert.equal(gunzipSync(await fs.readFile(network.items.get(uploaded.id).file)).toString(),body);
 assert.equal((await fetcher(`https://relay.test/network/${uploaded.id}/manifest?clientId=another`)).status,404);
 await assert.rejects(()=>fetcher('https://relay.test/worker/network/bad/part/0',{method:'POST',headers:{'X-Client-Id':'pc','X-Worker-Id':'worker','X-Content-SHA256':'wrong'},body:'bad'}),/checksum/);
});

test('reconstruction executes original ordered marks and stops on a mismatch',async()=>{
 const calls=[],session={networkArchives:[{id:'har'}]},engine={fresh:async()=>session,openKnownBuyMenu:async()=>calls.push('menu'),clickMark:async(s,c,m)=>calls.push(m.id),runSequence:async(s,c,m)=>calls.push(m.id),dispose:async()=>calls.push('close')};
 const route={jobId:'job',routeId:1,gameId:42,steps:[{sourceCapture:{state:'BUY_MENU'},mark:{id:1,kind:'click'}},{sourceCapture:{},mark:{id:2,kind:'sequence'}}]};
 const report=await replayRoute(engine,route);assert.deepEqual(calls,['menu',1,2,'close']);assert.equal(report.status,'replayed');assert.equal(report.originalOutcomeGuaranteed,false);
 engine.clickMark=async()=>{throw Error('VISUAL_STATE_MISMATCH');};calls.length=0;const partial=await replayRoute(engine,route);assert.equal(partial.status,'partial');assert.equal(calls.at(-1),'close');assert.equal(partial.steps.length,1);
});

test('concurrent downloads share the same operation and keep corruption out of exports',async t=>{
 const dir=await directory(t);let reads=0;const client={clientId:'pc',call:async(route,options)=>{
  reads++;await new Promise(resolve=>setTimeout(resolve,5));return options?.raw?new Response('corrupt'):{metadata:{kind:'har'},parts:[{size:7,sha256:'invalid'}]};
 }};
 const network=new NetworkClient({dataDir:dir},client);await network.start();
 const results=await Promise.allSettled([network.download('archive'),network.download('archive')]);
 assert.ok(results.every(r=>r.status==='rejected'&&/checksum/.test(r.reason.message)));assert.equal(reads,2);assert.equal(network.items.size,0);
 await assert.rejects(()=>fs.stat(path.join(dir,'network','archive.har.gz')));
});

test('replay restart polls the same immutable command and never resends uncertain actions',async t=>{
 const dir=await directory(t);let submissions=0;const browser={workers:[{id:'worker-har4',capacity:8,live:[]}],client:{submit:async()=>{submissions++;},read:async()=>({state:'uncertain',error:'Worker expired'})}};
 const options={config:{dataDir:dir},db:{},scheduler:{setPause(){}},network:{download:async()=>{}},browser};
 const first=new ReplayManager(options);await first.init();first.jobs.set('job',{id:'job',status:'running',routes:[{route:{routeId:1},status:'dispatched',commandId:'original',workerId:'worker-har4'}]});await first.save(first.jobs.get('job'));first.stop();
 const resumed=new ReplayManager(options);await resumed.init();t.after(()=>resumed.stop());await resumed.pump();await resumed.pump();
 assert.equal(submissions,0);assert.equal(resumed.jobs.get('job').status,'complete-with-gaps');assert.equal(resumed.jobs.get('job').routes[0].commandId,'original');
});

test('new games cannot fall back to workers without traffic recording',()=>{
 const browser=new RemoteBrowser({captureNetworkRequired:true},{getMark:()=>null});
 browser.workers=[{id:'old-sequence3',capacity:8,live:[],active:0}];
 assert.equal(browser.canPrepare({id:1,parent_task_id:null}),false);
 browser.workers.push({id:'new-har4',capacity:8,live:[],active:0});
 assert.deepEqual(browser.modernSlots().map(w=>w.id),['new-har4']);assert.equal(browser.canPrepare({id:1,parent_task_id:null}),true);
});

test('real Chromium HAR includes query, method, headers, post body and response body',async t=>{
 const {BrowserEngine}=await import('../src/browser.js');const {chromium}=await import('playwright');const dir=await directory(t);
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"win":17}');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const endpoint=`http://127.0.0.1:${server.address().port}`;
 const engine=new BrowserEngine({dataDir:dir,captureNetwork:true,viewportWidth:800,viewportHeight:600,headless:true,gpuMode:'default'}, {},{chromiumLoader:async()=>({chromium:{launch:options=>chromium.launch({...options,channel:'chrome'})}})});t.after(()=>engine.stop());
 engine.enter=async session=>{await session.page.goto(endpoint);await session.page.evaluate(async()=>{await (await fetch('/spin?game=42',{method:'POST',headers:{'Content-Type':'application/json','X-Test-Trace':'original-action'},body:JSON.stringify({bet:3,buy:true})})).text();});};
 let archived;engine.onArchive=async session=>{archived=JSON.parse(await fs.readFile(session.harPath,'utf8'));};const session=await engine.fresh('https://www.pragmaticplay.fun/en/slots/test/');await engine.dispose(session);
 const entry=archived.log.entries.find(e=>e.request.url.endsWith('/spin?game=42'));assert.ok(entry);assert.equal(entry.request.method,'POST');assert.equal(entry.request.postData.text,'{"bet":3,"buy":true}');assert.ok(entry.request.headers.some(h=>h.name.toLowerCase()==='x-test-trace'&&h.value==='original-action'));const content=entry.response.content;assert.equal(content.encoding==='base64'?Buffer.from(content.text,'base64').toString():content.text,'{"win":17}');assert.ok(session.httpCount>=2);
});
