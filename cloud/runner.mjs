import fs from 'node:fs/promises';
import path from 'node:path';
import {BrowserEngine} from '../src/browser.js';
import {loadConfig,isIrreversible} from '../src/config.js';
import {captureOf,classifyMark,controlForMark} from '../src/actions.js';
import {observeFlow} from './flow.js';

if(process.env.GITHUB_ACTIONS!=='true'&&process.env.CLOUD_TEST_WORKER!=='1')throw Error('Use GitHub Actions para abrir los juegos');
if(process.env.CONFIRM_ADULT!=='true')throw Error('Falta autorización de adulto para demos');
const endpoint=process.env.CLOUD_URL?.replace(/\/$/,''),token=process.env.CLOUD_WORKER_TOKEN,clientId=process.env.CLOUD_CLIENT_ID;
if(!/^https:\/\//.test(endpoint||'')||!token||!clientId)throw Error('Falta configuración privada del worker');
const workerId=`gh-${process.env.GITHUB_RUN_ID||'test'}-${process.env.GITHUB_RUN_ATTEMPT||'1'}-${process.env.WORKER_INDEX||'1'}`;
const capacity=Number(process.env.GAMES_PER_WORKER||8);if(!Number.isInteger(capacity)||capacity<1||capacity>8)throw Error('Capacidad inválida');
const budget=Number(process.env.WORKER_MINUTES||60);if(!Number.isInteger(budget)||budget<1||budget>300)throw Error('Duración inválida');
const config={...loadConfig(),headless:true,retainRoots:true,initialLoadWaitMs:60000,maxLive:capacity,gpuMode:'default',dataDir:path.resolve('.local',workerId),transitionTimeoutMs:600000};
const tasks=new Map(),lineages=new Map(),db={getTask:id=>tasks.get(id),lineage:id=>lineages.get(id)||[]};
const engine=new BrowserEngine(config,db,{chromiumLoader:async()=>{
 const {chromium}=await import('playwright');return {chromium:{launch:options=>chromium.launch({...options,channel:'chrome',args:[...(options.args||[]),'--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']})}};
}});
const baseClick=engine.clickMark.bind(engine),baseShot=engine.screenshot.bind(engine);
engine.clickMark=async(session,capture,mark,options)=>{
 const kind=classifyMark(capture,mark).kind,control=controlForMark(capture,mark);
 session.cloudFlow||={};
 if(['buy','confirm'].includes(kind)||/buy free spins|purchase|comprar/i.test((control?.texts||[]).join(' '))){
  if(session.cloudFlow.completed)session.cloudFlow={};
  session.cloudFlow.purchasePending=true;
 }
 return baseClick(session,capture,mark,options);
};
engine.screenshot=async(session,taskId,options)=>{
 const result=await baseShot(session,taskId,options);
 session.cloudFlow||={};result.capture.flowCompletion=observeFlow(session.cloudFlow,result.capture);
 return result;
};
async function call(route,body){
 const r=await fetch(endpoint+route,{method:'POST',headers:{Authorization:'Bearer '+token,...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body instanceof FormData?body:JSON.stringify(body),signal:AbortSignal.timeout(30000)});
 const data=await r.json();if(!r.ok)throw Error(data.error||`Relay ${r.status}`);return data;
}
let stop=false;const active=new Set(),deadline=Date.now()+budget*60000;
process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
const heartbeat=async()=>{const r=await call('/worker/heartbeat',{workerId,clientId,capacity,active:active.size,live:[...engine.live.keys()]});if(r.stop)stop=true;return r;};
async function execute(command){
 const identity={workerId,token:command.token};
 try{
  await call(`/worker/${command.id}/start`,identity);
  let result,image;
  if(command.payload.op==='release'){await engine.release(command.payload.taskId);result={released:true};}
  else if(command.payload.op==='observe'){
   let session=engine.live.get(command.payload.taskId);
   if(!session&&command.payload.rootTask){
    const root=command.payload.rootTask;if(root.parent_task_id||root.id!==command.payload.taskId)throw Error('INVALID_ROOT_REFRESH');
    tasks.set(root.id,root);lineages.set(root.id,[]);await engine.prepare(root);session=engine.live.get(root.id);
    if(!session)throw Error('ROOT_SESSION_NOT_RETAINED');
   }
   if(!session)throw Error('LIVE_SESSION_LOST');
   const waitSeconds=command.payload.waitSeconds??0;if(!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>60)throw Error('INVALID_WAIT');
   await session.page.bringToFront();
   await new Promise(r=>setTimeout(r,waitSeconds*1000));
   const prepared=await engine.screenshot(session,command.payload.taskId,{rootMode:session.rootMode||'base',manualReason:'Actualización de la sesión original',actionApplied:false});
   image=await fs.readFile(prepared.file);result={capture:prepared.capture,live:true};
  }
  else{
   const {task,lineage}=command.payload;
   // Rebuilding a navigation menu is fine; replaying an old purchase is not.
   if(task.replay_branch&&lineage.slice(0,-1).some(s=>isIrreversible(classifyMark(captureOf(s.parent),s.mark).kind)))throw Error('LIVE_SESSION_LOST: no se reconstruye una compra anterior');
   tasks.set(task.id,task);for(const s of lineage)tasks.set(s.parent.id,s.parent);lineages.set(task.id,lineage);
   const prepared=await engine.prepare(task);image=await fs.readFile(prepared.file);result={capture:prepared.capture,live:prepared.live};
  }
  await heartbeat();
  const form=new FormData();form.set('metadata',JSON.stringify({...identity,result}));if(image)form.set('image',new Blob([image],{type:'image/jpeg'}),'capture.jpg');
  // Retrying a result upload never reissues the browser command.
  for(let n=0;;n++){try{await call(`/worker/${command.id}/complete`,form);break;}catch(e){if(n>=2)throw e;await new Promise(r=>setTimeout(r,1000));}}
  console.log(JSON.stringify({event:'capture_saved',task:command.payload.task?.id,live:result.live||false}));
 }catch(e){await call(`/worker/${command.id}/fail`,{...identity,error:String(e.code||e.message).slice(0,250)}).catch(()=>{});console.log(JSON.stringify({event:'needs_review',command:command.id,error:String(e.code||'execution_error')}));}
}
await engine.start();await heartbeat();
const timer=setInterval(()=>heartbeat().catch(()=>{stop=true;}),20000);
try{
 while(!stop&&Date.now()<deadline){
  if(active.size<capacity){const {command}=await call('/worker/claim',{workerId,clientId,allowNew:engine.liveCount()+active.size<capacity});
   if(command){const promise=execute(command);active.add(promise);promise.finally(()=>active.delete(promise));continue;}
  }
  await new Promise(r=>setTimeout(r,700));
 }
 await Promise.allSettled(active);
}finally{clearInterval(timer);await engine.stop();await heartbeat().catch(()=>{});}
