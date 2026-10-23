import fs from 'node:fs';
import {publicDemoUrl,providerFor} from './providers.js';
export function hasFeatures(row){return row?.purchasesPresent===true||row?.antebetsPresent===true||[row?.purchases,row?.antebets].some(n=>Number.isInteger(n)&&n>0);}
export function importTesterCatalog(db,file){
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(data.source!=='Tester-Spin'||!Array.isArray(data.catalog))throw Error('Invalid Tester Spin catalog');
  let rejected=0;const urls=[];
  for(const row of data.catalog){
    if(!hasFeatures(row))continue;
    try{const url=publicDemoUrl(row.url);if(providerFor(url)!==row.provider)throw Error('Provider mismatch');urls.push(url);}catch{rejected++;}
  }
  const result=db.importUrls(urls);
  const update=db.db.prepare('UPDATE games SET name=? WHERE url=?');
  for(const row of data.catalog)if(typeof row.name==='string')update.run(row.name.slice(0,200),row.url);
  return {...result,rejected};
}
