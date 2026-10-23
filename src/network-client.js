import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import {gunzip} from 'node:zlib';import {promisify} from 'node:util';
const unzip=promisify(gunzip);
export class NetworkClient{
 constructor(config,client){this.dir=path.join(config.dataDir,'network');this.client=client;this.items=new Map();this.pending=new Map();this.syncing=false;this.error=null;this.activeDownloads=0;this.waiters=[];}
 async start(){await fs.mkdir(this.dir,{recursive:true});for(const file of await fs.readdir(this.dir)){if(!file.endsWith('.manifest.json'))continue;try{const item=JSON.parse(await fs.readFile(path.join(this.dir,file),'utf8'));if(item.metadata.kind==='har'&&!item.requestFile){item.requestFile=await this.index(item);await fs.writeFile(path.join(this.dir,file),JSON.stringify(item));}this.items.set(item.id,item);}catch{}}}
 async download(id){if(this.items.has(id))return this.items.get(id);if(this.pending.has(id))return this.pending.get(id);const work=this.downloadLimited(id);this.pending.set(id,work);try{return await work;}finally{this.pending.delete(id);}}
 async downloadLimited(id){if(this.activeDownloads>=3)await new Promise(resolve=>this.waiters.push(resolve));else this.activeDownloads++;try{return await this.downloadOnce(id);}finally{const next=this.waiters.shift();if(next)next();else this.activeDownloads--;}}
 async downloadOnce(id){if(this.items.has(id))return this.items.get(id);const params=new URLSearchParams({clientId:this.client.clientId}),manifest=await this.client.call(`/network/${id}/manifest?${params}`);
 const file=path.join(this.dir,id+'.har.gz'),handle=await fs.open(file+'.partial','w');try{for(let index=0;index<manifest.parts.length;index++){const r=await this.client.call(`/network/${id}/part/${index}?${params}`,{raw:true}),bytes=Buffer.from(await r.arrayBuffer()),expected=manifest.parts[index];if(bytes.length!==expected.size||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw Error('Network archive checksum mismatch');await handle.writeFile(bytes);}}finally{await handle.close();}
 await fs.rename(file+'.partial',file);
 let requestFile=manifest.metadata.kind==='har'?await this.index({...manifest,file}):null;
 const item={...manifest,file,requestFile};await fs.writeFile(path.join(this.dir,id+'.manifest.json'),JSON.stringify(item));this.items.set(id,item);return item;
 }
 async index(item){
  const har=JSON.parse((await unzip(await fs.readFile(item.file))).toString('utf8'));
  const entries=(har.log?.entries||[]).map(entry=>({at:entry.startedDateTime,request:entry.request,response:{status:entry.response.status,statusText:entry.response.statusText,headers:entry.response.headers,content:entry.response.content?.encoding==='base64'?{mimeType:entry.response.content.mimeType,size:entry.response.content.size,encoding:'base64',bodyInHar:true}:entry.response.content},time:entry.time}));
  const requestFile=path.join(this.dir,item.id+'.requests.json');await fs.writeFile(requestFile,JSON.stringify({schemaVersion:1,archiveId:item.id,metadata:item.metadata,entries},null,2));return requestFile;
 }
 async sync(){if(this.syncing)return;this.syncing=true;try{let cursor=null;do{const params=new URLSearchParams({clientId:this.client.clientId});if(cursor)params.set('cursor',cursor);const page=await this.client.call('/network?'+params);for(const item of page.items)if(!this.items.has(item.id))await this.download(item.id);cursor=page.cursor;}while(cursor);this.error=null;}catch(e){this.error=e.message;}finally{this.syncing=false;}}
 list(){return [...this.items.values()].map(({file,requestFile,parts,...item})=>({...item,requestsAvailable:Boolean(requestFile)})).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
}
