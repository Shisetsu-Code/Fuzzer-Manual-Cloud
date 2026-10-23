import './cloud-env.js';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConfig} from './config.js';
import {CatalogDB} from './db.js';
import {ImageCache} from './cache.js';
import {describeQueue} from './queue-context.js';
import {RemoteBrowser} from './remote-browser.js';
import {FleetRecovery} from './fleet-recovery.js';
import {launchFleet} from './fleet.js';
import {captureOf,captureNeedsLive,captureCanBranch} from './actions.js';
import {Scheduler} from './scheduler.js';
import {featureFilter} from './feature-filter.js';
import {ProviderLimits} from './provider-limits.js';
import {importTesterCatalog} from './catalog-import.js';
import {PROVIDERS} from './providers.js';
import {auditInitialCaptures} from './startup-audit.js';
import {exportHistory,historyCsv} from './history.js';
import {importSelectedGames} from './manual-import.js';

const config=loadConfig(),db=new CatalogDB(config.dataDir,{sqliteCacheMb:config.sqliteCacheMb});
const refreshingTasks=new Set();
const cache=new ImageCache(config.imageCacheMb*1024*1024);
const browser=new RemoteBrowser(config,db);
const scheduler=new Scheduler({db,browser,cache,workers:config.workers,rootWorkers:0,providerIds:Object.keys(PROVIDERS),previewCount:config.previewCount,readyGamesTarget:config.readyGamesTarget,
  providerLimits:new ProviderLimits(db),eligibleRoot:()=>true});
// Only recover local polling. Remote commands retain their immutable IDs.
db.db.prepare("UPDATE tasks SET status='queued' WHERE status='preparing'").run();
await browser.start();
const recovery=new FleetRecovery({db,browser,launch:launchFleet});
const recoveryTimer=setInterval(()=>recovery.tick().catch(e=>{recovery.error=e.message;}),10000);recoveryTimer.unref();
// Reattach outstanding read-only observations when updating the local client.
const restoreFile=path.join(config.dataDir,'restore-observations.json');
const restoring=await fs.readFile(restoreFile,'utf8').then(JSON.parse).catch(()=>[]);
for(const pending of restoring){const task=db.getTask(pending.taskId);if(task?.status!=='ready'||refreshingTasks.has(task.id))continue;
 refreshingTasks.add(task.id);browser.waitForResult(pending.id,task).then(result=>{db.refreshReady(task.id,result);cache.invalidate(result.file);}).catch(e=>{browser.lastError=`Captura #${task.id}: ${e.message}`;}).finally(()=>refreshingTasks.delete(task.id));
}
if(restoring.length)await fs.unlink(restoreFile).catch(()=>{});
const here=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(here,'../public');
const staticPaths=new Map([['/', ['index.html','text/html; charset=utf-8']],['/app.js',['app.js','text/javascript; charset=utf-8']],['/style.css',['style.css','text/css; charset=utf-8']]]);

function json(res,status,body){const content=Buffer.from(JSON.stringify(body));res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8','Content-Length':content.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);}
function error(res,e){const msg=String(e.message||e);const status=/not found/i.test(msg)?404:/already cataloged|not ready/i.test(msg)?409:400;json(res,status,{error:msg});}
async function receive(req){
  const parts=[];let size=0;
  for await(const part of req){size+=part.length;if(size>4*1024*1024)throw Error('Request exceeds 4 MiB');parts.push(part);}
  try{return JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('Invalid JSON');}
}
async function handler(req,res){
  try{
    const allowed=new Set([`127.0.0.1:${config.port}`,`localhost:${config.port}`]);
    if(!allowed.has(req.headers.host))return json(res,403,{error:'Host no permitido'});
    if(req.headers.origin&&!allowed.has(new URL(req.headers.origin).host))return json(res,403,{error:'Origen no permitido'});
    const u=new URL(req.url,'http://localhost');const p=u.pathname;
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if(req.method==='GET'&&staticPaths.has(p)){
      const [file,mime]=staticPaths.get(p);const content=await fs.readFile(path.join(publicDir,file));
      res.writeHead(200,{'Content-Type':mime,'Content-Length':content.length,'Cache-Control':'no-cache'});res.end(content);return;
    }
    if(req.method==='GET'&&p==='/api/status')return json(res,200,{...scheduler.status(),cloud:{clientId:browser.client.clientId,workers:browser.workers,operations:[...browser.operations.values()],refreshingTasks:[...refreshingTasks],error:browser.lastError||recovery.error,launching:recovery.busy||!browser.workers.length&&Date.now()-db.getSetting('last-fleet-start',0)<120000}});
    if(req.method==='GET'&&p==='/api/providers')return json(res,200,{providers:Object.entries(PROVIDERS).map(([id,[name]])=>({id,name,...db.providerBuffer()[id]})),limits:{intervalMs:60000,maxGames:100,maxCaptures:100}});
    if(req.method==='GET'&&p==='/api/progress')return json(res,200,{games:db.gameProgress()});
    if(req.method==='GET'&&p==='/api/history/export'){
      const provider=u.searchParams.get('provider')||null,format=u.searchParams.get('format')||'json';
      if(provider&&!Object.hasOwn(PROVIDERS,provider))throw Error('Invalid provider');
      if(!['csv','json'].includes(format))throw Error('Invalid export format');
      const history=exportHistory(db,{provider,reviewOnly:u.searchParams.get('review')==='1'});
      const content=format==='csv'?historyCsv(history):JSON.stringify(history,null,2);
      res.writeHead(200,{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/json; charset=utf-8','Content-Disposition':`attachment; filename="historial-${provider||'todos'}.${format}"`,'Cache-Control':'no-store'});res.end(content);return;
    }
    const reviewGame=p.match(/^\/api\/games\/(\d+)\/review$/);
    if(req.method==='POST'&&reviewGame){const body=await receive(req);return json(res,200,db.setReview(Number(reviewGame[1]),body.review));}
    if(req.method==='GET'&&p==='/api/queue'){
      const limit=Math.min(250,Math.max(1,Number(u.searchParams.get('limit')||100)||100));
      return json(res,200,{items:describeQueue(db,db.listReady(limit,u.searchParams.get('provider')||null)).map(item=>({...item,live:browser.hasLive(item.id)})),problems:db.listProblems(30)});
    }
    const image=p.match(/^\/api\/images\/(\d+)$/);
    if(req.method==='GET'&&image){
      const task=db.getTask(Number(image[1]));if(!task?.capture_file)return json(res,404,{error:'Image not found'});
      const dir=path.resolve(config.dataDir,'shots');const target=path.resolve(task.capture_file);
      if(!target.startsWith(dir+path.sep))return json(res,403,{error:'Outside snapshot directory'});
      const bytes=await cache.load(target);
      res.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':bytes.length,'Cache-Control':'private, max-age=31536000, immutable'});res.end(bytes);return;
    }
    const task=p.match(/^\/api\/tasks\/(\d+)$/);
    if(req.method==='GET'&&task){const id=Number(task[1]),item=db.getTask(id);return item?json(res,200,{task:item,marks:db.marksForTask(id),lineage:db.lineage(id)}):json(res,404,{error:'Unknown task'});}
    if(req.method==='POST'&&p==='/api/import'){
      const body=await receive(req);
      const imported=importSelectedGames(db,body.urls);scheduler.pump();return json(res,200,imported);
    }
    if(req.method==='POST'&&p==='/api/cloud/stop'){scheduler.setPause(true);db.setSetting('fleet-recovery-enabled',false);await browser.client.call('/fleet/stop',{method:'POST',body:{clientId:browser.client.clientId}});return json(res,200,{ok:true});}
    if(req.method==='POST'&&p==='/api/run'){
      const body=await receive(req);
      if(body.running){db.setSetting('fleet-recovery-enabled',true);if(body.fleet)db.setSetting('fleet-options',body.fleet);}
      if(body.running&&!browser.workers.length){
       if(Date.now()-db.getSetting('last-fleet-start',0)<120000)throw Error('La flota ya está arrancando; esperá a que aparezcan los workers.');
       await launchFleet(browser.client.clientId,body.fleet||{});db.setSetting('last-fleet-start',Date.now());
      }
      scheduler.setPause(!Boolean(body.running));return json(res,200,{paused:scheduler.paused});
    }
    const refresh=p.match(/^\/api\/tasks\/(\d+)\/refresh$/);
    if(req.method==='POST'&&refresh){const id=Number(refresh[1]),task=db.getTask(id);if(task?.status!=='ready')throw Error('La captura ya fue clasificada');if(refreshingTasks.has(id))throw Error('Esta captura ya está esperando');const body=await receive(req);refreshingTasks.add(id);try{const result=await browser.refresh(task,{waitSeconds:body.waitSeconds??0});db.refreshReady(id,result);cache.invalidate(result.file);return json(res,200,{ok:true});}finally{refreshingTasks.delete(id);}}
    const commit=p.match(/^\/api\/tasks\/(\d+)\/commit$/);
    if(req.method==='POST'&&commit){
      const id=Number(commit[1]);if(refreshingTasks.has(id))throw Error('Esperá la captura nueva antes de enviar clics');const data=await receive(req);
      const source=captureOf(db.getTask(id));
      if(data.captureVersion&&data.captureVersion!==source.capturedAt)throw Error('La captura cambió; revisá las marcas sobre la imagen nueva antes de guardar');
      if(source.flowCompletion?.version&&captureNeedsLive(source)&&!captureCanBranch(source)&&data.marks?.length>1)throw Error('Esta pantalla usa una sesión viva: elegí una opción por vez. En un menú inicial podés marcar varias.');
      const result=db.commit(id,data.marks);
      if(result.marks===0||result.independent)await browser.release(id);
      scheduler.pump();return json(res,200,result);
    }
    const finish=p.match(/^\/api\/tasks\/(\d+)\/finish$/);
    if(req.method==='POST'&&finish){const id=Number(finish[1]);const result=db.finish(id);await browser.release(id);scheduler.pump();return json(res,200,result);}
    const finishGame=p.match(/^\/api\/games\/(\d+)\/finish$/);
    if(req.method==='POST'&&finishGame){const body=await receive(req);const pending=captureOf(body.taskId?db.getTask(Number(body.taskId)):null).flowCompletion;if(pending?.purchasePending&&!pending.terminalPurchase)throw Error('El bonus o su premio siguen pendientes: continuá en la misma sesión o cerrá solo la rama.');const result=db.finishGame(Number(finishGame[1]),body.taskId?Number(body.taskId):null);if(result.taskId)await browser.release(result.taskId);scheduler.pump();return json(res,200,result);}
    const release=p.match(/^\/api\/tasks\/(\d+)\/release$/);
    if(req.method==='POST'&&release){await browser.release(Number(release[1]));return json(res,200,{ok:true});}
    if(req.method==='GET'&&p==='/api/settings')return json(res,200,{hotkeys:db.getSetting('hotkeys',null),features:{antebet:true,finish:true,finishGame:true,freeClicks:true}});
    if(req.method==='POST'&&p==='/api/settings'){
      const body=await receive(req);
      if(body.hotkeys){const h=body.hotkeys;
        if(!h||typeof h!=='object'||Object.keys(h).length>12||Object.values(h).some(s=>typeof s!=='string'||s.length>30))throw Error('Invalid hotkeys');
        db.setSetting('hotkeys',h);
      }
      return json(res,200,{ok:true});
    }
    return json(res,404,{error:'Not found'});
  }catch(e){error(res,e);}
}
const server=http.createServer(handler);
server.headersTimeout=10000;server.requestTimeout=60000;
server.listen(config.port,config.host,()=>{
  console.log(`Fuzzer Manual: http://${config.host}:${config.port}`);
  console.log(`Data: ${config.dataDir}, workers=${config.workers}, GPU=${config.gpuMode}, live=${config.maxLive}`);
  scheduler.start();
  console.log('Capturas y clasificación locales; navegadores en GitHub.');
});
async function close(){clearInterval(recoveryTimer);scheduler.setPause(true);scheduler.stop();server.close();await browser.stop();db.close();}
let shuttingDown=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!shuttingDown){shuttingDown=true;close().finally(()=>process.exit(0));}});
