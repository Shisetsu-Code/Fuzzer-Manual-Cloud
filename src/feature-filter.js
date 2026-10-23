import fs from 'node:fs';
import {hasFeatures} from './catalog-import.js';

// Only confirmed counts admit new games. Unknown is not evidence of absence.
export function featureFilter(file){
  let stamp=null,games=null,urls=new Map();
  return task=>{
    if(task.manual_requested_at)return true;
    try{
      const next=fs.statSync(file).mtimeMs;
      if(next!==stamp){
        const data=JSON.parse(fs.readFileSync(file,'utf8'));
        if(data.source!=='Tester-Spin'||!data.games||typeof data.games!=='object')return false;
        games=data.games;urls=new Map((data.catalog||[]).map(row=>[row.url,row]));stamp=next;
      }
      const entry=urls.get(task.url)||games[(task.provider||'pragmatic')+':'+task.slug]||((task.provider||'pragmatic')==='pragmatic'?games[task.slug]:null);
      return hasFeatures(entry);
    }catch{return false;}
  };
}
