export class Scheduler {
  constructor({db,browser,cache,workers=3,rootWorkers=0,providerIds=[],previewCount=50,readyGamesTarget=20,eligibleRoot=()=>true,providerLimits=null,onProgress=()=>{}}){
    this.db=db;this.browser=browser;this.cache=cache;this.workers=workers;
    this.previewCount=previewCount;this.onProgress=onProgress;
    this.active=new Set();this.activeRoots=new Set();this.readyGamesTarget=readyGamesTarget;this.errors=[];this.paused=db.getSetting('paused',true);this.timer=null;
    this.preloadActive=false;this.closed=false;this.recoveries=0;this.eligibleRoot=eligibleRoot;this.providerLimits=providerLimits;this.rootWorkers=rootWorkers;this.rootProviders=new Set();
    this.providerIds=providerIds;
  }
  start(){if(this.timer)return;this.timer=setInterval(()=>this.pump(),350);this.timer.unref?.();if(!this.paused)this.pump();}
  stop(){this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=null;}
  setPause(paused){this.paused=!!paused;this.db.setSetting('paused',this.paused);if(!this.paused)this.pump();this.onProgress();}
  pump(){
    if(this.closed||this.paused)return;
    while(this.active.size<this.workers+this.rootWorkers){
      const buffer=this.db.bufferState();
      const counts=this.db.providerBuffer();
      const allowed=x=>!this.providerLimits||this.providerLimits.allowed(x,counts);
      const continuation=(!this.rootWorkers||this.active.size-this.activeRoots.size<this.workers)
        ?this.db.queuedBatch(20000).find(x=>x.parent_task_id&&allowed(x)&&!this.active.has(x.id)&&this.browser.canPrepare(x)):null;
      const root=(!this.rootWorkers||this.activeRoots.size<this.rootWorkers)&&(this.providerLimits||buffer.coveredGames<this.readyGamesTarget)
        ?this.db.bufferRoots(20000).find(x=>(!this.rootWorkers||!this.rootProviders.has(x.provider||'pragmatic'))&&allowed(x)&&this.eligibleRoot(x)&&!this.active.has(x.id)&&this.browser.canPrepare(x)):null;
      // Keep one loader available below the low-water mark; other workers
      // continue the operator's routes. Stored photos do not need live browsers.
      const reserveLoader=this.workers>1&&!this.activeRoots.size&&buffer.readyGames<Math.min(15,this.readyGamesTarget);
      const task=this.rootWorkers?(continuation||root):((root&&reserveLoader?root:continuation)||root);
      if(!task||!this.db.claim(task.id))break;
      this.providerLimits?.reserve(task);
      this.active.add(task.id);
      if(!task.parent_task_id){this.activeRoots.add(task.id);if(this.rootWorkers)this.rootProviders.add(task.provider||'pragmatic');}
      this.execute(task).finally(()=>{this.active.delete(task.id);this.activeRoots.delete(task.id);if(!task.parent_task_id)this.rootProviders.delete(task.provider||'pragmatic');this.pump();});
    }
  }
  async execute(task){
    try{
      let result;
      for(let attempt=0;;attempt++){
        try{result=await this.browser.prepare(task);break;}
        catch(e){if(!e.recoverable||attempt>=2||this.closed)throw e;this.recoveries++;}
      }
      this.db.ready(task.id,{capture_file:result.file,capture:result.capture});
      this.cache.invalidate(result.file);
      this.cache.load(result.file).catch(()=>{});
      this.warmup();
    }catch(e){
      const code=e.code||e.message||'UNKNOWN';
      if(code==='LIVE_SLOTS_FULL'||code==='LIVE_SESSION_BUSY'){this.db.fail(task.id,'queued',String(e.message));return;}
      const status=this.browser.hasLive?.(task.id)||['LIVE_SESSION_LOST','STATE_MISMATCH','CONTROL_MISSING','UNVERIFIED_COORDINATE','VISUAL_STATE_MISMATCH','BUY_MENU_NOT_REOPENED','RUNTIME_UNAVAILABLE','CLICK_OUTSIDE_DEMO'].includes(code)?'blocked':'failed';
      this.db.fail(task.id,status,String(e.message||e));
      this.errors.push({taskId:task.id,reason:String(e.message||e).slice(0,180)});
      if(this.errors.length>20)this.errors.shift();
    }finally{this.onProgress();}
  }
  async warmup(){
    if(this.preloadActive||this.closed)return;
    this.preloadActive=true;
    try{
      const list=this.db.listReady(this.previewCount);
      // Prefetch conservatively: async disk I/O and bounded LRU, never all images in RAM.
      for(const task of list){if(this.closed)break;if(task.capture_file)await this.cache.load(task.capture_file).catch(()=>{});}
    }finally{this.preloadActive=false;}
  }
  providerWorkers(){
    const counts=this.db.providerBuffer(),queued=new Map();
    for(const task of this.db.bufferRoots(20000))if(this.eligibleRoot(task))queued.set(task.provider||'pragmatic',(queued.get(task.provider||'pragmatic')||0)+1);
    const ids=new Set([...this.providerIds,...queued.keys(),...this.rootProviders]);
    return [...ids].map(provider=>{
      const count=counts[provider]||{},pending=queued.get(provider)||0;
      const waitMs=Math.max(0,this.db.getSetting('provider-next:'+provider,0)-(this.providerLimits?.now()??Date.now()));
      const state=this.rootProviders.has(provider)?'working':this.paused?'paused':this.providerLimits&&((count.games||0)>=this.providerLimits.maxGames||(count.captures||0)>=this.providerLimits.maxCaptures)?'limit':!pending?'empty':waitMs?'cooldown':'waiting';
      return {provider,state,pending,waitSeconds:Math.ceil(waitMs/1000),games:count.games||0,captures:count.captures||0};
    });
  }
  status(){return {paused:this.paused,active:this.active.size,workers:this.workers,rootWorkers:this.rootWorkers,providerWorkers:this.providerWorkers(),activeRoots:this.activeRoots.size,activeProviders:[...this.rootProviders],live:this.browser.liveCount(),maxLive:this.browser.config.maxLive,recoveries:this.recoveries,providers:this.db.providerBuffer(),limits:this.providerLimits?{intervalMs:this.providerLimits.intervalMs,maxGames:this.providerLimits.maxGames,maxCaptures:this.providerLimits.maxCaptures}:null,buffer:{...this.db.bufferState(),target:this.readyGamesTarget},
    db:this.db.stats(),cache:this.cache.stats(),browser:this.browser.metrics,errors:this.errors.slice(-5)};}
}
