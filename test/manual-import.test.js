import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {PROVIDERS,publicDemoUrl,providerFor} from '../src/providers.js';
import {featureFilter} from '../src/feature-filter.js';
import {importSelectedGames} from '../src/manual-import.js';
import {Scheduler} from '../src/scheduler.js';
import {ProviderLimits} from '../src/provider-limits.js';
import {ImageCache} from '../src/cache.js';

// One representative catalog or DEMO link for each registered provider.
export const examples={
 pragmatic:'https://www.pragmaticplay.fun/en/slots/candy-rush/',
 '1spin4win':'https://www.1spin4win.com/games/all-ways-egypt/',
 '3oaks':'https://3oaks.com/games/3-african-drums/',
 belatra:'https://belatragames.com/games/mummyland-treasures/',
 bgaming:'https://demo.bgaming-network.com/play/3LuckyMonkeys/FUN?server=demo',
 hacksaw:'https://www.hacksawgaming.com/games/wanted-dead-or-a-wild',
 ka_gaming:'https://www.kagaming.com/games/',
 nolimit_city:'https://playin.com/embed/v1/demo/afk',
 redtiger:'https://games.evolution.com/red-tiger/',rubyplay:'https://rubyplay.com/games/',
 yggdrasil:'https://yggdrasilgaming.com/games/',playtech:'https://www.playtechone.com/games/',
 games_global:'https://www.gamesglobal.com/games/',amusnet:'https://amusnet.com/games/',
 playngo:'https://www.playngo.com/games',greentube:'https://www.greentube.com/games/',
 netent:'https://www.netent.com/games/',pgsoft:'https://www.pgsoft.com/games/',
 blueprint:'https://blueprintgaming.com/games/',relax:'https://www.relax-gaming.com/products/casino/',
 playson:'https://playson.com/games/',wazdan:'https://wazdan.com/games',
 elk:'https://www.elk-studios.com/games/',pushgaming:'https://www.pushgaming.com/games',
 thunderkick:'https://www.thunderkick.com/games/second-thunder/',quickspin:'https://quickspin.com/slots/crown-of-valor/'
};

test('manual URL list imports and schedules every registered provider without feature evidence',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-selected-')),db=new CatalogDB(dir);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.deepEqual(Object.keys(examples).sort(),Object.keys(PROVIDERS).sort());
 const result=importSelectedGames(db,Object.values(examples).join('\r\n'));
 assert.equal(result.added,26);assert.equal(result.rejected.length,0);
 const eligible=featureFilter(path.join(dir,'no-feature-file.json'));
 const tasks=db.bufferRoots(100);assert.equal(tasks.length,26);
 for(const [provider,url] of Object.entries(examples)){
  assert.equal(providerFor(publicDemoUrl(url)),provider);
  assert.equal(result.providers[provider].added,1);
  assert.ok(eligible(tasks.find(x=>x.provider===provider)),provider);
 }
});

test('manual import prioritizes existing queued games, tolerates bad lines and preserves marks',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-selected-mixed-')),db=new CatalogDB(dir);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.importUrls([examples.pragmatic,examples.bgaming]);
 const mixed=['',examples.bgaming,'https://evil.example/demo',examples.bgaming,'not a URL',examples.pragmatic].join('\n');
 const result=importSelectedGames(db,mixed);
 assert.equal(result.existing,2);assert.equal(result.duplicates,1);assert.deepEqual(result.rejected.map(x=>x.line),[3,5]);
 assert.equal(db.stats().games,2);assert.ok(db.bufferRoots()[0].manual_requested_at);
 db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE'}});db.commit(1,[{x:.2,y:.3}]);
 importSelectedGames(db,examples.pragmatic);assert.equal(db.marksForTask(1).length,1);
 assert.equal(db.getTask(1).status,'annotated');
 const eligible=featureFilter(path.join(dir,'missing.json'));assert.equal(eligible({provider:'bgaming',slug:'unknown'}),false);
 assert.throws(()=>importSelectedGames(db,Array(20001).fill(examples.bgaming)),/20,000/);
});

test('a mixed manual list starts 26 independent provider lanes and respects the rate limit',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-selected-workers-')),db=new CatalogDB(dir);let scheduler,now=100000;
 t.after(()=>{scheduler?.stop();db.close();fs.rmSync(dir,{recursive:true,force:true});});
 importSelectedGames(db,Object.values(examples));const calls=[];
 const browser={canPrepare:()=>true,liveCount:()=>0,config:{maxLive:4},metrics:{},async prepare(task){calls.push(task.provider);return {file:'fixture.jpg',capture:{state:'BASE'}};}};
 scheduler=new Scheduler({db,browser,cache:new ImageCache(16),workers:4,rootWorkers:26,providerIds:Object.keys(PROVIDERS),eligibleRoot:featureFilter(path.join(dir,'missing.json')),providerLimits:new ProviderLimits(db,{now:()=>now})});
 scheduler.setPause(false);for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));
 assert.equal(calls.length,26);assert.equal(new Set(calls).size,26);
 importSelectedGames(db,examples.pragmatic.replace('candy-rush','sweet-bonanza'));scheduler.pump();assert.equal(calls.length,26);
 now+=60000;scheduler.pump();for(let i=0;i<100&&scheduler.active.size;i++)await new Promise(r=>setTimeout(r,2));assert.equal(calls.length,27);
});

test('selected games appear before catalog games in both preparation and ready queues',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-selected-priority-')),db=new CatalogDB(dir);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.importUrls([examples.pragmatic,examples.bgaming]);importSelectedGames(db,examples.bgaming);
 assert.equal(db.bufferRoots()[0].provider,'bgaming');
 for(const id of [1,2]){db.claim(id);db.ready(id,{capture_file:'x',capture:{state:'BASE'}});}
 assert.equal(db.listReady()[0].provider,'bgaming');
});
