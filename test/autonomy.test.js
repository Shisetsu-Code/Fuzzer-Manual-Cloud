import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {BrowserEngine} from '../src/browser.js';
import {captureState,classifyMark} from '../src/actions.js';

const yes='GameRoot/Game/RA/BuyFeature/PurchaseManager/BuyWindow/Content/BF/Offset/Buttons/ButtonYes';
const next='GameRoot/Game/RA/FreeSpins/Content/RA/Start/ButtonContinue';
const control=p=>({path:p,hit:{x:.4,y:.4,w:.2,h:.2},handlers:[]});
const view=(state,controls)=>({state,controls,signature:state+'|'+controls.map(c=>c.path).join('|'),scan:{supported:true,loading:false},clip:{x:0,y:0,width:1000,height:600}});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-auto-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/starlight-princess/']);
  return {db,root:db.getTask(1)};
}
function ready(db,task,capture){db.claim(task.id);db.ready(task.id,{capture_file:'fixture.jpg',capture});}
function engineFor(db,initial,after){
  const engine=new BrowserEngine({maxLive:1,postClickDelayMs:0},db);let state=initial,closed=0,clicks=0;
  const session={events:[],context:{close:async()=>{closed++;}},page:{mouse:{click:async()=>{clicks++;state=typeof after==='function'?after(clicks):after;}}}};
  engine.fresh=async()=>session;engine.dismissConsent=async()=>{};engine.observe=async()=>state;
  const wait=engine.waitForGameReady.bind(engine);
  engine.waitForGameReady=(s,options={})=>wait(s,{...options,timeoutMs:500,stableMs:2,pollMs:1});
  engine.screenshot=async(s,id,{rootMode='base'}={})=>({file:'fixture.jpg',capture:{state:state.state,controls:state.controls,rootMode}});
  return {engine,session,closed:()=>closed,clicks:()=>clicks};
}

test('unattended initial manual photos release their browser and can later reopen with visual validation',async t=>{
  const {db,root}=fixture(t),unknown={...view('UNKNOWN',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'};
  const f=engineFor(db,unknown,unknown);f.session.manualReason='Revisión manual';
  f.engine.screenshot=async()=>({file:'fixture.jpg',capture:{...unknown,manualReview:true,manualToken:'old',visualKey:'saved'}});
  const result=await f.engine.prepare(root);
  assert.equal(result.capture.replayableRoot,true);assert.equal(result.capture.requiresLive,false);
  assert.equal(f.engine.liveCount(),0);assert.equal(f.closed(),1);
});

test('purchase and explicit antebet marks create independent branches without reclassification',t=>{
  const {db,root}=fixture(t);const purchase='Game/FeaturePurchase/PurchaseWindow/content/Options/Option1/Button';
  ready(db,root,view('BUY_MENU',[control(purchase)]));
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'buy'},{x:.5,y:.5,kind:'antebet'}]);
  assert.deepEqual(children.map(c=>c.kind),['buy','antebet']);
  assert.notEqual(children[0].taskId,children[1].taskId);
});

test('a live BASE capture can split menu and antebet into fresh independent workers',async t=>{
  const {db,root}=fixture(t);const spin=view('BASE',[control('Game/StartSpin_Button')]);ready(db,root,spin);
  const first=db.commit(root.id,[{x:.5,y:.5,kind:'spin'}]).children[0];
  const menu=control('Game/FeaturePurchase/MainButton');menu.hit={x:.1,y:.1,w:.2,h:.2};
  const ante={...control('Game/BetLevel/Level_0'),texts:['OFF']};
  const base={...view('BASE',[menu,ante]),requiresLive:true,rootMode:'menu'};
  ready(db,db.getTask(first.taskId),base);
  const split=db.commit(first.taskId,[{x:.2,y:.2,kind:'buy'},{x:.5,y:.5,kind:'antebet'}]);
  assert.equal(split.independent,true);assert.deepEqual(split.children.map(c=>c.kind),['navigate','antebet']);
  for(const c of split.children){
    assert.equal(db.getTask(c.taskId).fresh_start,1);
    const steps=db.lineage(c.taskId);assert.equal(steps.length,1);
    assert.equal(JSON.parse(steps[0].parent.capture_json).requiresLive,false);
    assert.equal(JSON.parse(steps[0].parent.capture_json).rootMode,'base');
  }
  const f=engineFor(db,view('BASE',[menu,ante]),view('BUY_MENU',[control('Game/FeaturePurchase/PurchaseWindow/content/Options/Option1/Button')]));
  const original={page:{},context:{}};f.engine.live.set(first.taskId,original);f.engine.config.maxLive=4;
  const task=db.getTask(split.children[0].taskId);assert.equal(f.engine.canPrepare(task),true);
  const result=await f.engine.prepare(task);
  assert.equal(result.live,false);assert.equal(f.clicks(),1);assert.equal(f.closed(),1);
  assert.equal(f.engine.live.get(first.taskId),original);
});

test('queued fresh branches survive startup without replaying a previous spin',t=>{
  const {db,root}=fixture(t);ready(db,root,{state:'BASE',requiresLive:true});
  db.db.prepare('UPDATE tasks SET depth=24 WHERE id=?').run(root.id);
  const split=db.commit(root.id,[{x:.2,y:.2,kind:'navigate'},{x:.5,y:.5,kind:'antebet'}]);
  db.recoverLostSessions();
  for(const c of split.children){assert.equal(db.getTask(c.taskId).status,'queued');assert.equal(db.getTask(c.taskId).depth,1);}
});

test('a fresh antebet branch maps a previously ON switch to its default OFF variant',async t=>{
  const {db}=fixture(t);const before=view('BASE',[{...control('Game/BetLevel/Levels/Level_1'),texts:['ON']}]);
  const off=view('BASE',[{...control('Game/BetLevel/Levels/Level_0'),texts:['OFF']},control('Game/StartSpin_Button')]);
  const on=view('BASE',[{...control('Game/BetLevel/Levels/Level_1'),texts:['ON']},control('Game/StartSpin_Button')]);
  const f=engineFor(db,off,n=>n===1?on:{...on,signature:'spin-result'});
  await f.engine.runAntebet(f.session,before,{x:.5,y:.5,kind:'antebet'});
  assert.equal(f.clicks(),2);assert.equal(f.session.antebetFlow.phase,'done');
});

test('antebet closes the purchase menu before spinning and retains its own session',async t=>{
  const {db,root}=fixture(t);
  const ante={...control('Game/AnteBet/Button'),texts:['OFF']};
  const close=control('Game/FeaturePurchase/PurchaseWindow/content/CloseButton/Collider');
  const spin=control('Game/SpinButtons/StartSpin_Button');
  const before=view('BUY_MENU',[ante,close,spin]);
  const enabled=view('BUY_MENU',[{...ante,texts:['ON']},close,spin]);
  const base=view('BASE',[{...ante,texts:['ON']},spin]);
  const done={...base,signature:'spin-finished'};
  ready(db,root,before);
  const child=db.commit(root.id,[{x:.5,y:.5,kind:'antebet'}]).children[0];
  const f=engineFor(db,before,n=>[enabled,base,done][n-1]);
  const result=await f.engine.prepare(db.getTask(child.taskId));
  assert.equal(f.clicks(),3);assert.equal(result.capture.antebet.phase,'done');
  assert.equal(result.live,true);assert.equal(f.engine.live.get(child.taskId),f.session);
});

test('antebet never spins through an unrecognized purchase menu',async t=>{
  const {db,root}=fixture(t);const ante={...control('Game/AnteBet/Button'),texts:['OFF']};
  const before=view('BUY_MENU',[ante,control('Game/SpinButtons/StartSpin_Button')]);
  ready(db,root,before);const child=db.commit(root.id,[{x:.5,y:.5,kind:'antebet'}]).children[0];
  const f=engineFor(db,before,view('BUY_MENU',[{...ante,texts:['ON']},control('Game/SpinButtons/StartSpin_Button')]));
  const result=await f.engine.prepare(db.getTask(child.taskId));
  assert.equal(f.clicks(),1);assert.equal(result.capture.antebet.phase,'close');
  assert.equal(result.live,true);
});

test('recovering an antebet capture never toggles or spins twice',async t=>{
  const {db,root}=fixture(t);const ante={...control('Game/AnteBet/Button'),texts:['OFF']};
  const spin=control('Game/SpinButtons/StartSpin_Button');
  const before=view('BASE',[ante,spin]);const enabled=view('BASE',[{...ante,texts:['ON']},spin]);
  const done={...enabled,signature:'spin-result'};ready(db,root,before);
  const child=db.commit(root.id,[{x:.5,y:.5,kind:'antebet'}]).children[0];
  const f=engineFor(db,before,n=>n===1?enabled:done);const screenshot=f.engine.screenshot;
  f.engine.screenshot=async()=>{throw Error('temporary screenshot failure');};
  await assert.rejects(()=>f.engine.prepare(db.getTask(child.taskId)),/temporary/);
  assert.equal(f.clicks(),2);assert.equal(f.engine.hasLive(child.taskId),true);
  f.engine.screenshot=screenshot;const result=await f.engine.prepare(db.getTask(child.taskId));
  assert.equal(f.clicks(),2);assert.equal(result.capture.antebet.phase,'done');
});

test('generic navigation on a known purchase confirmation is persisted as confirmation',t=>{
  const {db,root}=fixture(t);ready(db,root,{state:'BASE',controls:[control(yes)]});
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);
  assert.equal(db.getMark(children[0].markId).kind,'confirm');
});

test('a bonus reached through a generic control keeps the original session',async t=>{
  const {db,root}=fixture(t);const before=view('BASE',[control('GameRoot/UnknownButton')]);
  ready(db,root,before);const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);
  const f=engineFor(db,before,view('BONUS',[control(next)]));
  const task=db.getTask(children[0].taskId);const result=await f.engine.prepare(task);
  assert.equal(result.live,true);assert.equal(result.capture.requiresLive,true);
  assert.equal(f.engine.hasLive(task.id),true);assert.equal(f.closed(),0);assert.equal(f.clicks(),1);
});

test('an old BONUS ancestor is never rebuilt even when every mark says navigate',async t=>{
  const {db,root}=fixture(t);ready(db,root,{state:'BONUS',controls:[control(next)]});
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);
  const f=engineFor(db,view('BASE',[control('StartSpin_Button')]),view('BASE',[]));
  await assert.rejects(()=>f.engine.prepare(db.getTask(children[0].taskId)),{code:'LIVE_SESSION_LOST'});
  assert.equal(f.clicks(),0);
});

test('a live bonus continuation transfers the same session to the child',async t=>{
  const {db,root}=fixture(t);const before=view('BONUS',[control(next)]);ready(db,root,before);
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);const child=db.getTask(children[0].taskId);
  const f=engineFor(db,before,view('BASE',[control('StartSpin_Button')]));f.engine.live.set(root.id,f.session);
  const result=await f.engine.prepare(child);
  assert.equal(result.live,true);assert.equal(f.engine.live.get(child.id),f.session);
  assert.equal(f.engine.hasLive(root.id),false);assert.equal(f.clicks(),1);assert.equal(f.closed(),0);
});

test('a manual review child executes its operator click on the retained unknown-screen session',async t=>{
  const {db,root}=fixture(t);const before={...view('UNKNOWN',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture',manualReview:true,manualToken:'original'};
  ready(db,root,before);const child=db.commit(root.id,[{x:.5,y:.5,kind:'click'}]).children[0];
  const f=engineFor(db,before,view('BASE',[control('Game/StartSpin_Button')]));
  f.session.manualToken='original';f.session.manualReason='Revisión manual';f.engine.live.set(root.id,f.session);
  const result=await f.engine.prepare(db.getTask(child.taskId));
  assert.equal(f.clicks(),1);assert.equal(result.capture.state,'BASE');assert.equal(f.engine.live.get(child.taskId),f.session);
});

test('parallel jobs reserve the last live slot before awaiting browser startup',async t=>{
  const {db,root}=fixture(t);const before=view('BASE',[control('UnknownButton')]);ready(db,root,before);
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'},{x:.6,y:.6,kind:'navigate'}]);
  const f=engineFor(db,before,view('BONUS',[control(next)]));let resume;
  f.engine.fresh=()=>new Promise(resolve=>{resume=()=>resolve(f.session);});
  const pending=f.engine.prepare(db.getTask(children[0].taskId));
  assert.equal(f.engine.canPrepare(db.getTask(children[1].taskId)),false);
  resume();await pending;
});

test('pre-click validation waits through UNKNOWN without repeating the action',async()=>{
  const expected=view('BONUS',[control(next)]);const engine=new BrowserEngine({postClickDelayMs:0},null);let reads=0,clicks=0;
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>clicks?view('BASE',[control('StartSpin_Button')]):++reads<4?view('UNKNOWN',[]):expected;
  const wait=engine.waitForGameReady.bind(engine);
  engine.waitForGameReady=(s,options={})=>wait(s,{...options,timeoutMs:500,stableMs:2,pollMs:1});
  await engine.clickMark({page:{mouse:{click:async()=>{clicks++;}}}},expected,{x:.5,y:.5,kind:'navigate'});
  assert.equal(clicks,1);
});

test('a unique bonus menu accepts multiple clicks and explicitly queues reconstruction for additional branches',t=>{
  const {db,root}=fixture(t);ready(db,root,{state:'BONUS',requiresLive:true,controls:[control(next)]});
  const result=db.commit(root.id,[{x:.5,y:.5,kind:'click'},{x:.6,y:.6,kind:'click'}]);
  assert.equal(result.children.length,2);assert.equal(result.independent,false);
  assert.equal(db.getTask(result.children[0].taskId).replay_branch,0);
  assert.equal(db.getTask(result.children[1].taskId).replay_branch,1);
  assert.equal(db.stats().marks,2);
});

test('an additional unique-menu branch rebuilds its recorded route without taking the original session',async t=>{
  const {db,root}=fixture(t);const base=view('BASE',[control('Game/BuyButton')]);ready(db,root,base);
  const buy=db.commit(root.id,[{x:.5,y:.5,kind:'buy'}]).children[0];const confirmation=view('CONFIRM',[control(yes)]);
  ready(db,db.getTask(buy.taskId),{...confirmation,requiresLive:true});
  const accept=db.commit(buy.taskId,[{x:.5,y:.5,kind:'confirm'}]).children[0];
  const bonus=view('BONUS',[control('Game/UniqueMenu/Choice')]);ready(db,db.getTask(accept.taskId),{...bonus,requiresLive:true});
  const split=db.commit(accept.taskId,[{x:.5,y:.5,kind:'click'},{x:.5,y:.5,kind:'click'}]);
  const f=engineFor(db,base,n=>n===1?confirmation:n===2?bonus:view('BASE',[control('Game/StartSpin_Button')]));
  f.engine.config.maxLive=2;const original={page:{},context:{}};f.engine.live.set(accept.taskId,original);
  f.engine.busyParents.add(accept.taskId);
  const task=db.getTask(split.children[1].taskId);assert.equal(f.engine.canPrepare(task),true);
  const result=await f.engine.prepare(task);
  assert.equal(result.live,true);assert.equal(f.clicks(),3);
  assert.equal(f.engine.live.get(accept.taskId),original);assert.equal(f.engine.live.get(task.id),f.session);
});

test('a failed capture after a click recovers the same session without clicking again',async t=>{
  const {db,root}=fixture(t);const before=view('BASE',[control('UnknownButton')]);ready(db,root,before);
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);const child=db.getTask(children[0].taskId);
  const f=engineFor(db,before,view('BONUS',[control(next)]));const shot=f.engine.screenshot;
  f.engine.screenshot=async()=>{throw Error('temporary screenshot failure');};
  await assert.rejects(()=>f.engine.prepare(child),/temporary screenshot/);
  assert.equal(f.engine.hasLive(child.id),true);assert.equal(f.clicks(),1);
  f.engine.screenshot=shot;const result=await f.engine.prepare(child);
  assert.equal(result.live,true);assert.equal(f.clicks(),1);assert.equal(f.closed(),0);
});

test('active spin controls are not treated as a finished bonus screen',async()=>{
  const engine=new BrowserEngine({postClickDelayMs:0},null);let reads=0;
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>++reads<8?view('BONUS',[control('StopSpin_Button')]):view('BONUS',[control(next)]);
  const result=await engine.waitForGameReady({},{timeoutMs:500,stableMs:2,pollMs:1});
  assert.ok(result.controls.some(c=>c.path===next));
});

test('a failure in an earlier replay cannot recover as if the target action happened',async t=>{
  const {db,root}=fixture(t);const before=view('BASE',[control('UnknownButton')]);ready(db,root,before);
  const first=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]).children[0];
  ready(db,db.getTask(first.taskId),before);
  const target=db.getTask(db.commit(first.taskId,[{x:.5,y:.5,kind:'navigate'}]).children[0].taskId);
  const f=engineFor(db,before,view('UNKNOWN',[]));
  await assert.rejects(()=>f.engine.prepare(target),{code:'GAME_NOT_READY'});
  assert.equal(f.engine.hasLive(target.id),false);assert.equal(f.closed(),1);assert.equal(f.clicks(),1);
});

test('unexpected bonus roots cannot exceed the live-session limit',async t=>{
  const {db,root}=fixture(t);const f=engineFor(db,view('BONUS',[control(next)]),view('BONUS',[control(next)]));
  f.engine.live.set(999,{page:{},context:{close:async()=>{}}});
  await assert.rejects(()=>f.engine.prepare(root),{code:'LIVE_SLOTS_FULL'});
  assert.equal(f.engine.liveCount(),1);assert.equal(f.engine.canPrepare(root),false);assert.equal(f.closed(),1);
});

test('a root already showing the purchase menu records the correct replay entry mode',async t=>{
  const {db,root}=fixture(t);const before=view('BUY_MENU',[control('FeaturePurchase/PurchaseWindow/content/Options/Option1/Collider')]);
  const f=engineFor(db,before,before);const result=await f.engine.prepare(root);
  assert.equal(result.capture.rootMode,'menu');assert.equal(f.clicks(),0);
});

test('Sweet Bonanza purchase options are inferred without choosing a category',t=>{
  const {db,root}=fixture(t);ready(db,root,{state:'BASE',controls:[control('GameRoot/Game/FreeSpinsPurchase/Content/Options/Option_0/OptionButton')]});
  const {children}=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]);
  assert.equal(db.getMark(children[0].markId).kind,'buy');
});

test('legacy purchase roots with incorrect base mode still reopen their captured menu',async t=>{
  const {db,root}=fixture(t);
  const menu=view('BUY_MENU',[control('FeaturePurchase/PurchaseWindow/content/Options/Option1/Collider')]);
  ready(db,root,{...menu,rootMode:'base'});
  const child=db.getTask(db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]).children[0].taskId);
  const f=engineFor(db,view('BASE',[control('Game/FeaturePurchase/MainButton/Collider')]),n=>n===1?menu:view('CONFIRM',[control(yes)]));
  const result=await f.engine.prepare(child);
  assert.equal(result.capture.rootMode,'menu');assert.equal(f.clicks(),2);
});

test('a slow confirmation response cannot publish the old confirmation as the next screen',async()=>{
  const before=view('CONFIRM',[control(yes)]),after=view('BONUS',[control(next)]);
  const engine=new BrowserEngine({postClickDelayMs:0},null);let clickedAt=0,clicks=0;
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>!clickedAt||Date.now()-clickedAt<80?before:after;
  const wait=engine.waitForGameReady.bind(engine);
  engine.waitForGameReady=(s,options={})=>wait(s,{...options,timeoutMs:500,stableMs:2,pollMs:1});
  const result=await engine.clickMark({page:{mouse:{click:async()=>{clickedAt=Date.now();clicks++;}}}},before,{x:.5,y:.5,kind:'navigate'});
  assert.equal(result.state,'BONUS');assert.equal(clicks,1);
});

test('capture recovery still waits for an unacknowledged confirmation and never repeats it',async t=>{
  const {db,root}=fixture(t);const before=view('CONFIRM',[control(yes)]);ready(db,root,before);
  const child=db.getTask(db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]).children[0].taskId);
  const f=engineFor(db,before,before);
  await assert.rejects(()=>f.engine.prepare(child),{code:'GAME_NOT_READY'});
  assert.equal(f.engine.hasLive(child.id),true);
  await assert.rejects(()=>f.engine.prepare(child),{code:'GAME_NOT_READY'});
  assert.equal(f.clicks(),1);assert.equal(f.closed(),0);
});

test('Sweet Bonanza FSWindows start and result controls identify a bonus and its continuation',()=>{
  for(const stage of ['FSStart','FSResult']){
    const capture=view('UNKNOWN',[control(`GameRoot/Game/Reels/FSWindows/${stage}/ButtonContinue`)]);
    assert.equal(captureState(capture),'BONUS');
    assert.equal(classifyMark(capture,{x:.5,y:.5,kind:'navigate'}).kind,'continue');
  }
  assert.equal(captureState(view('UNKNOWN',[control('StopSpin_Button')])),'UNKNOWN');
  assert.equal(captureState(view('UNKNOWN',[control('Game/Reels/FSWindows/FSStart/ButtonContinue'),control(yes)])),'CONFIRM');
});


test('cloud roots keep the loading page alive so the operator can wait without replay',async t=>{
 const {db,root}=fixture(t),unknown={...view('UNKNOWN',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'};
 const f=engineFor(db,unknown,unknown);f.engine.config.retainRoots=true;f.session.manualReason='Carga pendiente';
 f.engine.screenshot=async()=>({file:'fixture.jpg',capture:{...unknown,manualReview:true}});
 const result=await f.engine.prepare(root);
 assert.equal(result.live,true);assert.equal(result.capture.requiresLive,true);assert.equal(result.capture.replayableRoot,undefined);
 assert.equal(f.engine.live.get(root.id),f.session);assert.equal(f.closed(),0);assert.equal(f.clicks(),0);
});


test('fresh sessions wait for their configured initial loading window before returning',async()=>{
 const engine=new BrowserEngine({initialLoadWaitMs:35},{ });engine.start=async()=>{};engine.resolveEntry=async url=>url;engine.enter=async()=>{};
 engine.browser={newContext:async()=>({newPage:async()=>({on(){}})})};
 const start=Date.now();const session=await engine.fresh('https://www.pragmaticplay.fun/en/slots/candy-rush/');assert.ok(Date.now()-start>=30);assert.equal(session.initialLoadWaitApplied,false);
});
