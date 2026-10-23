export class ProviderLimits{
  constructor(db,{intervalMs=60000,maxGames=100,maxCaptures=100,now=Date.now}={}){
    this.db=db;this.intervalMs=intervalMs;this.maxGames=maxGames;this.maxCaptures=maxCaptures;this.now=now;
  }
  allowed(task,counts){
    if(task.parent_task_id)return true; // A full root buffer must never freeze an active bonus.
    const provider=task.provider||'pragmatic',count=counts[provider]||{};
    if((count.captures||0)>=this.maxCaptures)return false;
    if(!task.parent_task_id&&(count.games||0)>=this.maxGames)return false;
    return Boolean(task.parent_task_id)||this.now()>=(this.db.getSetting('provider-next:'+provider,0));
  }
  reserve(task){if(!task.parent_task_id)this.db.setSetting('provider-next:'+(task.provider||'pragmatic'),this.now()+this.intervalMs);}
}
