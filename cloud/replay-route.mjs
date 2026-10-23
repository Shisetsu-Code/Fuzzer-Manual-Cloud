export async function replayRoute(engine,route){
 let session,error=null;const steps=[];
 try{
  session=await engine.fresh(route.url,{gameId:route.gameId,gameName:route.name,taskId:route.sourceTaskId,replayJobId:route.jobId,replayRouteId:route.routeId});session.gameId=route.gameId;session.taskId=route.sourceTaskId;session.replayJobId=route.jobId;session.replayRouteId=route.routeId;
  const root=route.steps[0]?.sourceCapture||route.initialCapture||{};
  if(root.rootMode==='menu'||root.state==='BUY_MENU')await engine.openKnownBuyMenu(session);
  for(const step of route.steps){
   const mark=step.mark,source=step.sourceCapture;session.taskId=step.resultTaskId;
   const result={markId:mark.id,sourceTaskId:step.sourceTaskId,resultTaskId:step.resultTaskId,kind:mark.kind,status:'started'};steps.push(result);
   if(mark.kind==='sequence')await engine.runSequence(session,source,mark);
   else if(mark.kind==='antebet'){await engine.runAntebet(session,source,mark);if(session.antebetFlow?.phase!=='done'){error='LEGACY_ANTEBET_SPIN_COORDINATE_NOT_RECORDED';result.status='partial';break;}}
   else await engine.clickMark(session,source?.manualReview?{...source,replayableRoot:true,requiresLive:false}:source,mark);
   result.status='input-sent';result.at=new Date().toISOString();
  }
 }catch(e){error=String(e.code||e.message).slice(0,300);if(steps.length&&steps.at(-1).status==='started')steps.at(-1).status='uncertain-or-not-sent';}
 finally{if(session)await engine.dispose(session);}
 return {schemaVersion:1,jobId:route.jobId,routeId:route.routeId,gameId:route.gameId,sourceTaskId:route.sourceTaskId,status:error?'partial':'replayed',error,steps,archives:session?.networkArchives||[],networkError:session?.networkArchiveError||null,reconstructed:true,originalOutcomeGuaranteed:false};
}
