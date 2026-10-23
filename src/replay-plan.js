import {captureOf} from './actions.js';
const fields=['state','rootMode','manualReview','entryReview','frameUrl','visualKey','clip','width','height','controls','antebet'];
const compact=task=>{const capture=captureOf(task);return Object.fromEntries(fields.filter(k=>capture[k]!==undefined).map(k=>[k,capture[k]]));};
export function buildReplayPlan(db,jobId){
 const games=db.db.prepare(`SELECT g.* FROM games g WHERE g.finished_at IS NOT NULL OR EXISTS(SELECT 1 FROM tasks t JOIN marks m ON m.task_id=t.id WHERE t.game_id=g.id) ORDER BY g.id`).all();const routes=[];
 for(const game of games){const leaves=db.db.prepare(`SELECT t.* FROM tasks t WHERE t.game_id=? AND t.via_mark_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM tasks child WHERE child.parent_task_id=t.id AND child.via_mark_id IS NOT NULL) ORDER BY t.id`).all(game.id);
  if(!leaves.length){const root=db.db.prepare('SELECT * FROM tasks WHERE game_id=? AND parent_task_id IS NULL ORDER BY id LIMIT 1').get(game.id);if(root)routes.push({routeId:routes.length,jobId,gameId:game.id,url:game.url,name:game.name||game.slug,sourceTaskId:root.id,steps:[],initialCapture:compact(root)});continue;}
  for(const leaf of leaves){try{const lineage=db.lineage(leaf.id);routes.push({routeId:routes.length,jobId,gameId:game.id,url:game.url,name:game.name||game.slug,sourceTaskId:leaf.id,originalStatus:leaf.status,steps:lineage.map((step,index)=>({sourceTaskId:step.parent.id,resultTaskId:index===lineage.length-1?leaf.id:lineage[index+1].parent.id,sourceCapture:compact(step.parent),mark:step.mark}))});}catch(e){routes.push({routeId:routes.length,jobId,gameId:game.id,url:game.url,sourceTaskId:leaf.id,planError:e.message,steps:[]});}}
 }
 return {schemaVersion:1,jobId,createdAt:new Date().toISOString(),gameCount:games.length,routeCount:routes.length,actionCount:routes.reduce((n,r)=>n+r.steps.length,0),routes};
}
