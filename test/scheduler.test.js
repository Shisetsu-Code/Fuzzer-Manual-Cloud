import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';import fs from 'node:fs';import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {Scheduler} from '../src/scheduler.js';
import {ImageCache} from '../src/cache.js';
const A='https://www.pragmaticplay.fun/en/slots/candy-rush/';

test('ineligible roots do not open browsers or starve eligible games after fifty entries',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-filter-queue-'));const db=new CatalogDB(dir);let scheduler;
  try{
    db.importUrls([...Array.from({length:60},(_,i)=>`https://www.pragmaticplay.fun/en/slots/empty-${i}/`),A]);
    const calls=[];const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls.push(task.slug);return {file:'fixture.jpg',capture:{state:'BASE'}};}};
    scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,eligibleRoot:t=>t.slug==='candy-rush'});scheduler.setPause(false);
    for(let i=0;i<100&&!db.stats().tasks.ready;i++)await new Promise(r=>setTimeout(r,5));
    assert.deepEqual(calls,['candy-rush']);assert.equal(db.stats().tasks.queued,60);
  }finally{scheduler?.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('idle workers fill a twenty-game buffer, stop there and replenish after consumption',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-buffer-'));const db=new CatalogDB(dir);let scheduler;
  try{
    db.importUrls(Array.from({length:30},(_,i)=>`https://www.pragmaticplay.fun/en/slots/test-${i}/`));
    let calls=0,active=0,peak=0;
    const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(){
      calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
      return {file:path.join(dir,'fixture.jpg'),capture:{state:'BASE'}};
    }};
    scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,readyGamesTarget:20});scheduler.setPause(false);
    for(let i=0;i<150&&(db.stats().tasks.ready||0)<20;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(db.stats().tasks.ready,20);assert.equal(calls,20);assert.ok(peak<=4);
    scheduler.pump();assert.equal(calls,20);
    db.commit(db.listReady()[0].id,[]);scheduler.pump();
    for(let i=0;i<100&&(db.stats().tasks.ready||0)<20;i++)await new Promise(r=>setTimeout(r,5));
    assert.equal(db.stats().tasks.ready,20);assert.equal(calls,21);
  }finally{scheduler?.stop();for(let i=0;i<100&&scheduler?.active.size;i++)await new Promise(r=>setTimeout(r,5));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('a busy route queue leaves one worker refilling the game buffer',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-fair-'));const db=new CatalogDB(dir);let scheduler;const releases=[];
  try{
    db.importUrls([A,'https://www.pragmaticplay.fun/en/slots/sweet-bonanza/']);db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE'}});
    db.commit(1,Array.from({length:8},()=>({x:.5,y:.5,kind:'navigate'})));
    const calls=[];const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},prepare(task){calls.push(task);return new Promise(resolve=>releases.push(()=>resolve({file:'fixture.jpg',capture:{state:'BASE'}})));}};
    scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4});scheduler.setPause(false);
    assert.equal(calls.length,4);assert.equal(calls.filter(t=>!t.parent_task_id).length,1);assert.equal(calls.filter(t=>t.parent_task_id).length,3);
  }finally{scheduler?.stop();releases.forEach(fn=>fn());for(let i=0;i<100&&scheduler?.active.size;i++)await new Promise(r=>setTimeout(r,5));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('scheduler calls browser adapter, persists snapshot, emits progress',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-sched-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  try{db.importUrls([A]);db.setSetting('paused',false);
    let calls=0;const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls++;return {file:path.join(dir,'fake.jpg'),capture:{state:'BASE'}};}};
    const scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:1});
    scheduler.pump();
    for(let i=0;i<100&&!(db.stats().tasks.ready);i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(calls,1);assert.equal(db.stats().tasks.ready,1);scheduler.stop();
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('scheduler retries a transient live capture without rebuilding its random action',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-recover-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  const cache=new ImageCache(16);let scheduler;
  try{
    db.importUrls([A]);let attempts=0;
    const browser={config:{maxLive:4},metrics:{},canPrepare:()=>true,liveCount:()=>1,
      async prepare(){attempts++;if(attempts===1){const e=Error('temporary capture failure');e.recoverable=true;throw e;}return {file:path.join(dir,'fake.jpg'),capture:{state:'BONUS',requiresLive:true}};}};
    scheduler=new Scheduler({db,browser,cache,workers:1});scheduler.setPause(false);
    for(let i=0;i<100&&!db.stats().tasks.ready;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(db.stats().tasks.ready,1);assert.equal(attempts,2);assert.equal(db.stats().tasks.failed||0,0);
  }finally{scheduler?.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
import {ProviderLimits} from '../src/provider-limits.js';
test('four workers never open two jobs for one provider in a minute, while another provider proceeds',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-multi-rate-')),db=new CatalogDB(dir);let scheduler,now=100000;const calls=[];
 try{
  db.importUrls([A,'https://www.pragmaticplay.fun/en/slots/sweet-bonanza/','https://demo.bgaming-network.com/play/Test/FUN?server=demo']);
  const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls.push(task.provider);return {file:'fixture.jpg',capture:{state:'BASE'}};}};
  scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,providerLimits:new ProviderLimits(db,{now:()=>now})});scheduler.setPause(false);
  for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));
  assert.deepEqual(calls,['pragmatic','bgaming']);scheduler.pump();assert.equal(calls.length,2);
  now+=60000;scheduler.pump();for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));
  assert.deepEqual(calls,['pragmatic','bgaming','pragmatic']);
 }finally{scheduler?.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('parallel workers reserve the hundredth photo and wait until a photo is classified',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-cap-')),db=new CatalogDB(dir);let scheduler;const calls=[];
 try{
  db.importUrls(Array.from({length:101},(_,i)=>`https://www.pragmaticplay.fun/en/slots/cap-${i}/`));
  for(let id=1;id<=99;id++){db.claim(id);db.ready(id,{capture_file:'fixture.jpg',capture:{state:'BASE'}});}
  const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls.push(task.id);return {file:'fixture.jpg',capture:{state:'BASE'}};}};
  scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,providerLimits:new ProviderLimits(db,{intervalMs:0})});scheduler.setPause(false);
  for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(calls.length,1);assert.equal(db.providerBuffer().pragmatic.captures,100);
  db.commit(1,[]);scheduler.pump();for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(calls.length,2);assert.equal(db.providerBuffer().pragmatic.captures,100);
 }finally{scheduler?.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('each provider prepares independently of the four classification workers',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-lanes-')),db=new CatalogDB(dir);let scheduler;const releases=[],calls=[];
 try{
  db.importUrls([A,'https://demo.bgaming-network.com/play/Test/FUN?server=demo','https://playin.com/embed/v1/demo/Test','https://www.hacksawgaming.com/games/test','https://quickspin.com/slots/test/','https://www.thunderkick.com/games/test/']);
  const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},prepare(task){calls.push(task);return new Promise(resolve=>releases.push(()=>resolve({file:'fixture.jpg',capture:{state:'BASE'}})));}};
  scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,rootWorkers:26,providerLimits:new ProviderLimits(db)});scheduler.setPause(false);
  assert.equal(calls.length,6);assert.equal(scheduler.activeRoots.size,6);assert.equal(new Set(calls.map(t=>t.provider)).size,6);
  assert.equal(scheduler.providerWorkers().filter(x=>x.state==='working').length,6);
  // A stalled provider keeps only its own lane; the other five can finish.
  releases.slice(1).forEach(fn=>fn());
  for(let i=0;i<100&&scheduler.activeRoots.size>1;i++)await new Promise(r=>setTimeout(r,2));
  assert.equal(scheduler.activeRoots.size,1);
  assert.equal(scheduler.providerWorkers().find(x=>x.provider==='pragmatic').state,'working');
  assert.equal(db.stats().tasks.ready,5);
 }finally{scheduler?.stop();releases.forEach(fn=>fn());for(let i=0;i<100&&scheduler?.active.size;i++)await new Promise(r=>setTimeout(r,2));db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
