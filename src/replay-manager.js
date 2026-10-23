import fs from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import {buildReplayPlan} from './replay-plan.js';
export class ReplayManager{
 constructor({config,db,browser,network,scheduler}){Object.assign(this,{db,browser,network,scheduler});this.dir=path.join(config.dataDir,'replays');this.jobs=new Map();this.busy=false;this.closed=false;}
 async init(){await fs.mkdir(this.dir,{recursive:true});for(const name of await fs.readdir(this.dir)){if(!name.endsWith('.json'))continue;try{const job=JSON.parse(await fs.readFile(path.join(this.dir,name),'utf8'));this.jobs.set(job.id,job);}catch{}}if([...this.jobs.values()].some(j=>j.status==='running'))this.scheduler.setPause(true);this.timer=setInterval(()=>this.pump().catch(()=>{}),3000);this.timer.unref();}
 async save(job){await fs.writeFile(path.join(this.dir,job.id+'.json.tmp'),JSON.stringify(job));await fs.rename(path.join(this.dir,job.id+'.json.tmp'),path.join(this.dir,job.id+'.json'));}
 async start(){const active=[...this.jobs.values()].find(j=>j.status==='running');if(active)return this.summary(active);const id=randomUUID(),plan=buildReplayPlan(this.db,id);const job={id,status:'running',createdAt:plan.createdAt,gameCount:plan.gameCount,routeCount:plan.routeCount,actionCount:plan.actionCount,routes:plan.routes.map(route=>({route,status:route.planError?'plan-error':'queued',commandId:`${this.browser.client.clientId}:replay:${id}:${route.routeId}`}))};this.scheduler.setPause(true);this.jobs.set(id,job);await this.save(job);this.pump().catch(()=>{});return this.summary(job);}
 summary(job){const counts={};for(const r of job.routes)counts[r.status]=(counts[r.status]||0)+1;return {id:job.id,status:job.status,createdAt:job.createdAt,gameCount:job.gameCount,routeCount:job.routeCount,actionCount:job.actionCount,counts};}
 list(){return [...this.jobs.values()].map(j=>this.summary(j));}
 async pump(){
  if(this.busy||this.closed)return;this.busy=true;
  try{
   const workers=this.browser.workers.filter(w=>w.id.endsWith('-har4'));
   for(const job of this.jobs.values()){
    if(job.status!=='running')continue;
    for(const item of job.routes.filter(r=>r.status==='dispatched')){
     if(this.closed)break;
     try{const row=await this.browser.client.read(item.commandId);
      if(row.state==='done'){
       item.report=row.result;item.status=row.result.status==='replayed'&&!row.result.networkError&&row.result.archives?.some(a=>a.metadata?.kind==='har')?'replayed':'partial';
       for(const archive of row.result.archives||[])this.network.download(archive.id).catch(e=>{item.downloadError=e.message;});
      }else if(['failed','uncertain'].includes(row.state)){item.status=row.state;item.error=row.error;}
     }catch(e){item.error=e.message;}
    }
    const loads=new Map(workers.map(w=>[w.id,job.routes.filter(r=>r.status==='dispatched'&&r.workerId===w.id).length]));
    for(const item of job.routes.filter(r=>r.status==='queued')){
     if(this.closed)break;
     const worker=workers.filter(w=>(loads.get(w.id)||0)<Math.max(0,w.capacity-(w.live?.length||0))).sort((a,b)=>loads.get(a.id)-loads.get(b.id))[0];if(!worker)break;
     try{await this.browser.client.submit(item.commandId,{op:'replay',route:item.route},worker.id);item.status='dispatched';item.workerId=worker.id;loads.set(worker.id,loads.get(worker.id)+1);}catch(e){item.error=e.message;}
    }
    if(!job.routes.some(r=>['queued','dispatched'].includes(r.status)))job.status=job.routes.every(r=>r.status==='replayed')?'complete':'complete-with-gaps';
    await this.save(job);
   }
  }finally{this.busy=false;}
 }

 stop(){this.closed=true;clearInterval(this.timer);}
}
