import fs from 'node:fs/promises';
import {publicDemoUrl,providerFor} from './providers.js';

export function entryCatalog(file){
 let stamp=null,entries=new Map();
 return async input=>{
  const original=publicDemoUrl(input);
  try{const next=(await fs.stat(file)).mtimeMs;if(next!==stamp){
   const data=JSON.parse(await fs.readFile(file,'utf8'));
   if(data.source!=='Tester-Spin')return original;
   entries=new Map((data.catalog||[]).filter(g=>g.launchUrl).map(g=>[g.url,g.launchUrl]));stamp=next;
  }
  const target=entries.get(original);if(!target)return original;
  const validated=publicDemoUrl(target);return providerFor(validated)===providerFor(original)?validated:original;
  }catch{return original;}
 };
}
