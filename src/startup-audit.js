import {readGameText,gameStartEvidence} from './game-start.js';
export async function auditInitialCaptures(db,{screenReader=readGameText,stopped=()=>false,onProgress=()=>{}}={}){
  const candidates=db.db.prepare("SELECT * FROM tasks WHERE status='ready' AND parent_task_id IS NULL AND capture_file IS NOT NULL").all();
  let cursor=0,checked=0,requeued=0;
  const replace=db.db.prepare("UPDATE tasks SET capture_json=?,status=?,updated_at=datetime('now') WHERE id=? AND status='ready' AND capture_json=? AND NOT EXISTS(SELECT 1 FROM marks WHERE task_id=?)");
  async function worker(){
    while(cursor<candidates.length&&!stopped()){
      const task=candidates[cursor++],capture=JSON.parse(task.capture_json||'{}');
      if(!capture.replayableRoot||capture.requiresLive||capture.startupVersion&&capture.gameRunning||capture.startupAuditVersion>=2||capture.entryReview)continue;
      let evidence;try{evidence=capture.state==='INTRO'?{state:'INTRO'}:gameStartEvidence(await screenReader(task.capture_file));}catch{continue;}
      if(stopped())break;
      const next={...capture,startupAuditVersion:2};let status='ready';
      if(evidence.state==='INTRO'){next.gameRunning=false;status='queued';}
      else if(evidence.state==='RUNNING'){next.gameRunning=true;next.startupVersion=1;}
      else next.gameRunning=false;
      const result=replace.run(JSON.stringify(next),status,task.id,task.capture_json,task.id);
      if(result.changes){checked++;if(status==='queued')requeued++;onProgress({checked,requeued});}
    }
  }
  await Promise.all([worker(),worker()]);return {checked,requeued};
}
