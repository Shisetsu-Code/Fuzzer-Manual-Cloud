export class FleetRecovery {
 constructor({db,browser,launch,now=Date.now}){Object.assign(this,{db,browser,launch,now});this.busy=false;this.error=null;}
 async tick(){
  if(this.busy||!this.db.getSetting('fleet-recovery-enabled',true)||!this.browser.pending.size)return;
  const options=this.db.getSetting('fleet-options',{workers:4,gamesPerWorker:8,minutes:60});
  const runtime=this.db.getSetting('fleet-runtime',null),available=runtime==='sequence3'?this.browser.workers.filter(w=>w.id.endsWith('-sequence3')).length:this.browser.workers.length;
  const missing=options.workers-available;
  if(missing<=0||this.now()-this.db.getSetting('last-fleet-start',0)<180000)return;
  this.busy=true;this.db.setSetting('last-fleet-start',this.now());
  try{await this.launch(this.browser.client.clientId,{...options,workers:missing});this.error=null;}
  catch(e){this.error=e.message;}finally{this.busy=false;}
 }
}
