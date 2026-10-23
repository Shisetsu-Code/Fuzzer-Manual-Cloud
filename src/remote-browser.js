import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureOf,captureNeedsLive} from './actions.js';

export class RelayClient {
 constructor({endpoint,token,clientId,fetcher=fetch}){
  if(!/^https:\/\//.test(endpoint||''))throw Error('Configurá CLOUD_URL con HTTPS');
  if(!token||!clientId)throw Error('Configurá CLOUD_CLIENT_TOKEN y CLOUD_CLIENT_ID');
  this.endpoint=endpoint.replace(/\/$/,'');this.token=token;this.clientId=clientId;this.fetcher=fetcher;
 }
 async call(route,{method='GET',body,raw=false}={}){
  const r=await this.fetcher(this.endpoint+route,{method,headers:{Authorization:'Bearer '+this.token,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
  if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||`Relay HTTP ${r.status}`);}
  return raw?r:r.json();
 }
 submit(id,payload,affinity=null){return this.call('/commands',{method:'POST',body:{id,clientId:this.clientId,payload,affinity}});}
 read(id){return this.call('/commands/'+id+'?'+new URLSearchParams({clientId:this.clientId}));}
}
const taskData=t=>Object.fromEntries(['id','game_id','url','parent_task_id','via_mark_id','fresh_start','replay_branch','depth','capture_json','provider','slug'].filter(k=>t[k]!==undefined).map(k=>[k,t[k]]));
export class RemoteBrowser {
 constructor(config,db,{client=null,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  this.config=config;this.db=db;this.sleep=sleep;this.metrics={sessionsOpened:0,screenshots:0,bytes:0,clicks:0,lastRenderer:'GitHub remoto'};
  this.client=client;this.workers=[];this.pending=new Set();this.operations=new Map();this.newReservations=new Map();this.closed=false;this.lastError=null;
 }
 async start(){
  if(!this.client){await fs.mkdir(this.config.dataDir,{recursive:true});const idFile=path.join(this.config.dataDir,'cloud-client-id');
   let clientId=process.env.CLOUD_CLIENT_ID;try{clientId||=(await fs.readFile(idFile,'utf8')).trim();}catch{}
   clientId||=randomUUID();await fs.writeFile(idFile,clientId,{mode:0o600});
   this.client=new RelayClient({endpoint:process.env.CLOUD_URL,token:process.env.CLOUD_CLIENT_TOKEN,clientId});
  }
  await this.refreshWorkers();
  this.timer=setInterval(()=>this.refreshWorkers().catch(e=>{this.lastError=e.message;}),5000);this.timer.unref?.();
 }
 async refreshWorkers(){this.workers=(await this.client.call('/workers?'+new URLSearchParams({clientId:this.client.clientId}))).workers;this.lastError=null;this.config.maxLive=this.workers.reduce((n,w)=>n+w.capacity,0);}
 stop(){this.closed=true;clearInterval(this.timer);return Promise.resolve();}
 hasLive(taskId){return this.workers.some(w=>w.live?.includes(Number(taskId)));}
 liveCount(){return this.workers.reduce((n,w)=>n+(w.live?.length||0),0);}
 modernSlots(sequence=false){sequence=sequence||this.workers.some(w=>w.id.endsWith('-sequence3'));return this.workers.filter(w=>(!sequence||w.id.endsWith('-sequence3'))&&/-(?:batch2|sequence3)$/.test(w.id)&&w.capacity-w.live.length-w.active-(this.newReservations.get(w.id)||0)>0);}
 canPrepare(task){if(task&&this.db.getMark?.(task.via_mark_id)?.kind==='sequence'){const source=this.db.getTask(task.parent_task_id);if(captureOf(source).remoteWorker?.endsWith('-sequence3')&&this.hasLive(task.parent_task_id))return true;return this.modernSlots(true).length>0;}if(task&&(task.replay_branch||task.fresh_start||!task.parent_task_id)&&this.workers.some(w=>/-(?:batch2|sequence3)$/.test(w.id)))return this.modernSlots().length>0;return this.workers.length>0;}
 async release(taskId){
  const worker=this.workers.find(w=>w.live?.includes(Number(taskId)));if(!worker)return false;
  await this.client.submit(`${this.client.clientId}:release:${taskId}`,{op:'release',taskId},worker.id);return true;
 }
 async prepare(task){
  const sequence=this.db.getMark?.(task.via_mark_id)?.kind==='sequence';
  if(sequence){const source=this.db.getTask(task.parent_task_id),worker=captureOf(source).remoteWorker;if(!worker?.endsWith('-sequence3'))task={...task,replay_branch:1};}
  if(task.provider&&task.provider!=='pragmatic'&&this.workers.some(w=>/-(?:batch2|sequence3)$/.test(w.id))&&this.db.getMark?.(task.via_mark_id)?.kind==='antebet')task={...task,replay_branch:1};
  const parent=task.parent_task_id?this.db.getTask(task.parent_task_id):null,capture=captureOf(parent);
  let affinity=!task.fresh_start&&!task.replay_branch&&captureNeedsLive(capture)?capture.remoteWorker:null;
  let reserved=null;if(task.replay_branch||task.fresh_start||!task.parent_task_id){const modern=this.modernSlots(sequence).sort((a,b)=>(a.active+a.live.length)-(b.active+b.live.length));if(modern.length){affinity=modern[0].id;reserved=affinity;this.newReservations.set(reserved,(this.newReservations.get(reserved)||0)+1);}else if(this.workers.some(w=>/-(?:batch2|sequence3)$/.test(w.id)))throw Error('LIVE_SLOTS_FULL');}
  if(captureNeedsLive(capture)&&!task.fresh_start&&!task.replay_branch&&!affinity)throw Error('LIVE_SESSION_LOST: falta el worker original');
  if(sequence&&!affinity?.endsWith('-sequence3'))throw Error('Esperando un worker actualizado para la secuencia');
  const lineage=this.db.lineage(task.id).map(s=>({parent:taskData(s.parent),mark:s.mark}));
  const id=`${this.client.clientId}:task:${task.id}`;
  try{
  await this.client.submit(id,{op:'prepare',task:taskData(task),lineage},affinity);
  const prepared=await this.waitForResult(id,task);
  if(!task.parent_task_id&&prepared.live&&!prepared.capture.initialLoadWaitApplied){
   const waitId=`${this.client.clientId}:initial-wait:${task.id}`;
   await this.client.submit(waitId,{op:'observe',taskId:task.id,waitSeconds:60},prepared.capture.remoteWorker);
   const final=await this.waitForResult(waitId,task);final.capture.initialLoadWaitApplied=true;return final;
  }
  return prepared;
  }finally{if(reserved)this.newReservations.set(reserved,Math.max(0,(this.newReservations.get(reserved)||1)-1));}
 }
 async refresh(task,{waitSeconds=0}={}){
  if(!Number.isInteger(waitSeconds)||waitSeconds<0||waitSeconds>60)throw Error("La espera debe ser de 0 a 60 segundos");
  const liveWorker=this.workers.find(w=>w.live?.includes(Number(task.id))),live=Boolean(liveWorker);
  if(!this.workers.length)throw Error('No hay workers activos. Encendé la flota antes de pedir otra captura.');
  if(!live&&task.parent_task_id)throw Error('La sesión de esta operación terminó. No se repiten compras ni tiradas.');
  const id=`${this.client.clientId}:observe:${task.id}:${randomUUID()}`;
  await this.client.submit(id,{op:'observe',taskId:task.id,waitSeconds,...(!live?{rootTask:taskData(task)}:{})},live?liveWorker.id:null);
  return this.waitForResult(id,task);
 }
 async waitForResult(id,task){
  this.pending.add(id);const queuedAt=Date.now();let transportFailures=0;
  try{
   while(!this.closed){
    let row;try{row=await this.client.read(id);transportFailures=0;}catch(e){if(++transportFailures>=5)throw e;await this.sleep(1500);continue;}
    this.operations.set(task.id,{taskId:task.id,commandId:id,state:row.state,workerId:row.workerId||null});
    if(row.state==='queued'&&Date.now()-queuedAt>300000)throw Error('No hay un worker libre para esta captura. La solicitud sigue en cola; no se repite ninguna acción.');
    if(['failed','uncertain'].includes(row.state))throw Error(row.error||'LIVE_SESSION_LOST: operación incierta; no se repite');
    if(row.state==='done'){
     const dir=path.join(this.config.dataDir,'shots');await fs.mkdir(dir,{recursive:true});
     const file=path.join(dir,`task-${task.id}.jpg`),r=await this.client.call('/commands/'+id+'/image?'+new URLSearchParams({clientId:this.client.clientId}),{raw:true});
     const bytes=Buffer.from(await r.arrayBuffer());if(bytes.length>8*1024*1024||bytes[0]!==255||bytes[1]!==216)throw Error('Captura JPEG inválida');
     await fs.writeFile(file+'.tmp',bytes);await fs.rename(file+'.tmp',file);
     this.metrics.screenshots++;this.metrics.bytes+=bytes.length;
     return {file,capture:{...row.result.capture,remoteWorker:row.workerId,remoteCommand:id},live:row.result.live};
    }
    await this.sleep(1000);
   }
   throw Error('LOCAL_CLIENT_CLOSED: el trabajo remoto conserva su identidad');
  }finally{this.pending.delete(id);if(this.operations.get(task.id)?.commandId===id)this.operations.delete(task.id);}
 }
}
