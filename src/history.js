import {captureOf} from './actions.js';

// Export the recorded graph, rather than the replay shortcut: fresh branches
// still retain their full operator history and explicitly describe their reset.
export function exportHistory(db,{provider=null,reviewOnly=false}={}){
 const tasks=db.db.prepare('SELECT * FROM tasks ORDER BY id').all();
 const marks=db.db.prepare('SELECT * FROM marks ORDER BY task_id,ordinal').all();
 const byTask=new Map(tasks.map(t=>[t.id,t])),byMark=new Map(marks.map(m=>[m.id,m]));
 const marksByTask=new Map();for(const m of marks){if(!marksByTask.has(m.task_id))marksByTask.set(m.task_id,[]);marksByTask.get(m.task_id).push(m);}
 const grouped=new Map();for(const t of tasks){if(!grouped.has(t.game_id))grouped.set(t.game_id,[]);grouped.get(t.game_id).push(t);}
 const stepFor=task=>{
   const mark=byMark.get(task.via_mark_id),parent=byTask.get(task.parent_task_id);
   if(!mark||!parent)return null;
   const source=captureOf(parent),result=captureOf(task),width=source.width??source.clip?.width??null,height=source.height??source.clip?.height??null;
   return {markId:mark.id,sourceTaskId:parent.id,resultTaskId:task.id,ordinal:mark.ordinal,kind:mark.kind,label:mark.label,
     x:mark.x,y:mark.y,sourceImage:{width,height,clip:source.clip??null,capturedAt:source.capturedAt??null},
     imagePixel:width&&height?{x:mark.x*width,y:mark.y*height}:null,
     freshStart:!!task.fresh_start,replayBranch:!!task.replay_branch,status:task.status,
     applied:task.capture_json?result.actionApplied!==false:null,resultState:result.state??null,completion:result.flowCompletion??null,antebet:result.antebet??null,error:task.error};
 };
 const games=db.gameProgress().filter(g=>(!provider||g.provider===provider)&&(!reviewOnly||g.reviewRequestedAt)).map(g=>({
   ...g,name:g.name||g.slug,routes:(grouped.get(g.id)||[]).map(task=>{
     const steps=[],seen=new Set();let node=task;
     while(node?.via_mark_id){if(seen.has(node.id))throw Error('Cyclic route');seen.add(node.id);const step=stepFor(node);if(!step)throw Error('Broken route');steps.push(step);node=byTask.get(node.parent_task_id);}
     return {taskId:task.id,parentTaskId:task.parent_task_id,status:task.status,createdAt:task.created_at,updatedAt:task.updated_at,error:task.error,steps:steps.reverse(),marks:(marksByTask.get(task.id)||[])};
   })
 }));
 return {schemaVersion:1,exportedAt:new Date().toISOString(),provider,reviewOnly,coordinates:'x/y normalized 0..1 relative to the source screenshot; imagePixel is relative to that image, not the desktop',replayNote:'Routes record operator marks. Antebet macros may execute additional automatic actions; inspect antebet phase and applied status. Random bonuses cannot be reproduced exactly from coordinates alone.',games};
}

const csvCell=value=>{
 let text=typeof value==='object'?JSON.stringify(value):String(value??'');
 if(/^[\s]*[=+@-]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
};
export function historyCsv(history){
 const rows=[['proveedor','nombre','id','slug','enlace','revision','compras_realizadas','compras_marcadas','compras_pendientes','compras_con_problemas','antebets_realizados','antebets_marcados','antebets_pendientes','antebets_con_problemas','caminos_pendientes','finalizado','rutas_y_coordenadas_json']];
 for(const g of history.games)rows.push([g.provider,g.name,g.id,g.slug,g.url,g.reviewRequestedAt||'',g.purchases.completed,g.purchases.marked,g.purchases.pending,g.purchases.problems,g.antebets.completed,g.antebets.marked,g.antebets.pending,g.antebets.problems,g.pendingPaths,g.finishedAt||'',g.routes]);
 return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}
