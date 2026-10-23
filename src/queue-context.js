import {captureOf} from './actions.js';
import {signatureDiff} from './visual.js';
const labels={sequence:'Secuencia de clics',spin:'Tirada normal',buy:'Compra',confirm:'Confirmación de compra',antebet:'Antebet',antebet_toggle:'Activar antebet',continue:'Continuar',navigate:'Abrir / navegar',click:'Clic manual'};
export function sameScreen(a,b){
 if(!a.visualKey||!b.visualKey||a.state!==b.state)return false;
 const aw=a.width??a.clip?.width,ah=a.height??a.clip?.height,bw=b.width??b.clip?.width,bh=b.height??b.clip?.height;
 if(!(aw>0&&ah>0&&aw===bw&&ah===bh))return false;
 const sameControls=a.signature&&a.signature===b.signature&&!a.signature.startsWith('manual|');
 return Boolean(sameControls||signatureDiff(a.visualKey,b.visualKey)<=0.015);
}
export function describeQueue(db,items){
 const games=new Map();
 for(const item of items){if(games.has(item.game_id))continue;
  const rows=db.db.prepare(`SELECT t.*,m.kind,m.label,m.x,m.y,m.ordinal,p.capture_json AS source_capture FROM tasks t JOIN marks m ON m.id=t.via_mark_id JOIN tasks p ON p.id=t.parent_task_id WHERE t.game_id=? ORDER BY t.id DESC LIMIT 200`).all(item.game_id).reverse();
  games.set(item.game_id,rows);
 }
 const described=items.map(item=>{
  const task=db.getTask(item.id),capture=captureOf(task),rows=games.get(item.game_id),byId=new Map(rows.map(r=>[r.id,r]));
  const path=[];let node=task;const seen=new Set();
  while(node?.parent_task_id&&!seen.has(node.id)){seen.add(node.id);const step=byId.get(node.id);if(!step)break;path.unshift(step);node=db.getTask(node.parent_task_id);}
  let anchor=path[0];
  for(const step of path){if(['sequence','spin','buy','antebet'].includes(step.kind)||db.marksForTask(step.parent_task_id).length>1)anchor=step;}
  const history=rows.map(row=>{const result=captureOf(row),source=row.source_capture?JSON.parse(row.source_capture):{};
   const applied=row.capture_json&&result.actionApplied===true;
   const status=applied?'ejecutado':['queued','preparing'].includes(row.status)?'pendiente':result.actionApplied===false?'no ejecutado':'sin confirmar';
   return {id:row.id,parentId:row.parent_task_id,kind:row.kind,label:labels[row.kind]||'Clic manual',note:row.label||'',x:row.x,y:row.y,status,applied:Boolean(applied),sequencePoints:row.kind==='sequence'?result.sequence?.completed||[]:null,sameScreen:Boolean(applied&&sameScreen(source,capture)),lastAction:Boolean(applied&&row.id===task.id&&(source.width??source.clip?.width)===(capture.width??capture.clip?.width)&&(source.height??source.clip?.height)===(capture.height??capture.clip?.height)),onRoute:path.some(p=>p.id===row.id),freshStart:Boolean(row.fresh_start||row.replay_branch)};
  });
  return {...item,parent_task_id:task.parent_task_id,operation:{id:anchor?.id??task.id,label:anchor?(labels[anchor.kind]||'Navegación'):'Pantalla inicial',linked:Boolean(task.parent_task_id),parentId:task.parent_task_id,freshStart:Boolean(task.fresh_start||task.replay_branch),route:path.map(r=>r.id)},previousClicks:history.filter(h=>h.sameScreen||h.lastAction).flatMap(h=>h.sequencePoints?h.sequencePoints.map(point=>({...h,x:point.x,y:point.y,sequenceIndex:point.index})):[h]),actionHistory:history.slice(-50),spinSummary:{executed:history.filter(h=>h.kind==='spin'&&h.applied).length,pending:history.filter(h=>h.kind==='spin'&&h.status==='pendiente').length,uncertain:history.filter(h=>h.kind==='spin'&&h.status==='sin confirmar').length}};
 });
 const unique=new Map();for(const item of described){const key=`${item.game_id}:${item.operation.id}`;if(!unique.has(key))unique.set(key,item);}
 return [...unique.values()];
}
