import {publicDemoUrl,providerFor} from './providers.js';

export function importSelectedGames(db,input){
 const lines=Array.isArray(input)?input:typeof input==='string'?input.split(/\r\n|\n|\r/):null;
 if(!lines||lines.length>20000)throw Error('Send up to 20,000 URLs, one per line');
 const rejected=[],providers={},seen=new Set(),groups=new Map();let added=0,existing=0,duplicates=0;
 for(let index=0;index<lines.length;index++){
  const raw=lines[index];if(typeof raw==='string'&&!raw.trim())continue;
  let url;try{url=publicDemoUrl(raw);}catch(e){rejected.push({line:index+1,error:String(e.message)});continue;}
  if(seen.has(url)){duplicates++;continue;}seen.add(url);
  const provider=providerFor(url);if(!groups.has(provider))groups.set(provider,[]);groups.get(provider).push(url);
 }
 for(const [provider,urls] of groups){
  const result=db.importUrls(urls,{manual:true});providers[provider]={added:result.added,existing:result.existing};
  added+=result.added;existing+=result.existing;
 }
 return {added,existing,duplicates,unique:seen.size,rejected,providers};
}
