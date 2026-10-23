import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {gameStartEvidence} from '../src/game-start.js';
import {BrowserEngine} from '../src/browser.js';
import {CatalogDB} from '../src/db.js';
import {auditInitialCaptures} from '../src/startup-audit.js';
const line=text=>({text,x:.3,y:.8,w:.4,h:.1});
const intro={lines:[line('CLICK TO START')]};
const running={lines:[line('Balance 1,000.00 FUN'),line('Total bet'),line('2.00 FUN')]};
test('welcome prompts are distinguished from a running game, loading, and purchase controls',()=>{
  assert.equal(gameStartEvidence(intro).state,'INTRO');assert.equal(gameStartEvidence(running).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[...running.lines,line('CONTINUE')]}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[...running.lines,line('LOADING')]}).state,'LOADING');
  for(const text of ['START SPIN','BUY BONUS','CONFIRM PURCHASE','START','SPIN','MAX WIN 5000'])assert.equal(gameStartEvidence({lines:[line(text)]}).state,'UNKNOWN');
  assert.equal(gameStartEvidence({lines:[line('SYMBOLS PAY ANYWHERE'),line('START')]}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('SYMBOLS PAY ANYWHERE'),line('BUY BONUS'),line('START')]}).state,'UNKNOWN');
  assert.equal(gameStartEvidence({lines:[line('FREEPLAY'),line('10000'),line('BET 10'),line('START')]}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('IN GAME FEATURES'),line('—CONTINUE—')]}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('VOLATILIDAD'),line('JUGAR')]}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('BET OPTIONS'),line('TOTAL BET €5.00'),line('CONFIRM')]}).state,'SETUP');
  assert.equal(gameStartEvidence({lines:[line('BUY BONUS'),line('TOTAL BET €5.00'),line('CONFIRM')]}).state,'UNKNOWN');
  assert.equal(gameStartEvidence({lines:[line('LINES 1'),line('WIN'),line('TOTAL BET €5.00')]},{provider:'playtech'}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('Créditos 100000'),line('Apuesta 100')]}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('mPRESS ANYWHERETOSTART')]}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('PRESS SPIN TO BEGIN')]}).state,'UNKNOWN');
  assert.equal(gameStartEvidence({lines:[line('DEMO PLAY €5000'),line('BET €1')]}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('REEPtAY 5000'),line('BET+ 1.00')]}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('WIN 10001X'),line('PLAY')]},{provider:'redtiger'}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('BET+'),line('AUTO'),line('5000.00'),line('1.00')]},{provider:'thunderkick'}).state,'RUNNING');
  assert.equal(gameStartEvidence({lines:[line('TO ACTIVATE FLOATING WILD'),line('START')]},{provider:'rubyplay'}).state,'INTRO');
  assert.equal(gameStartEvidence({lines:[line('CASH €10000'),line('TOTAL BET €1'),line('PRESS SPIN TO START GAME')]}).state,'RUNNING');
});
test('the initial welcome is clicked once, then balance and bet must appear',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-start-'));let reads=0,clicks=0;
  const engine=new BrowserEngine({dataDir:dir,postClickDelayMs:0,gameStartTimeoutMs:200,gameStartPollMs:1},null,{screenReader:async()=>++reads===1?intro:running});
  engine.dismissConsent=async()=>{};engine.observeGeneric=async()=>({clip:{x:0,y:0,width:1000,height:600},frameUrl:'https://demo.bgaming-network.com/play/Test/FUN?server=demo'});
  const session={page:{screenshot:async()=>{},mouse:{click:async(x,y)=>{assert.equal(x,500);assert.ok(Math.abs(y-510)<.01);clicks++;}}}};
  try{await engine.ensureGenericStarted(session);assert.equal(clicks,1);assert.equal(session.genericRunning,true);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('an unchanged welcome is never clicked repeatedly or declared running',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-start-stuck-'));let clicks=0;
  const engine=new BrowserEngine({dataDir:dir,postClickDelayMs:0,gameStartTimeoutMs:25,gameStartPollMs:1},null,{screenReader:async()=>intro});
  engine.dismissConsent=async()=>{};engine.observeGeneric=async()=>({clip:{x:0,y:0,width:1000,height:600},frameUrl:'https://demo.bgaming-network.com/play/Test/FUN?server=demo'});
  const session={page:{screenshot:async()=>{},mouse:{click:async()=>{clicks++;}}}};
  try{await engine.ensureGenericStarted(session);assert.equal(clicks,1);assert.equal(session.genericRunning,false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('saved welcome photos are queued for startup while running photos and marked routes are preserved',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-start-audit-')),db=new CatalogDB(dir);
  try{
    db.importUrls([1,2,3].map(i=>`https://www.pragmaticplay.fun/en/slots/audit-${i}/`));
    for(let id=1;id<=3;id++){db.claim(id);db.ready(id,{capture_file:'photo-'+id,capture:{state:'UNKNOWN',manualReview:true,replayableRoot:true,requiresLive:false}});}
    db.commit(3,[{x:.5,y:.5,kind:'click'}]);
    const result=await auditInitialCaptures(db,{screenReader:async file=>file==='photo-1'?intro:running});
    assert.deepEqual(result,{checked:2,requeued:1});assert.equal(db.getTask(1).status,'queued');
    assert.equal(JSON.parse(db.getTask(2).capture_json).gameRunning,true);assert.equal(db.getTask(3).status,'annotated');
  }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('adapter upgrade refreshes only unmarked pending roots once, preserving running games and recorded paths',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-adapter-upgrade-')),db=new CatalogDB(dir);
 try{
  db.importUrls([1,2,3].map(i=>`https://www.pragmaticplay.fun/en/slots/upgrade-${i}/`));
  for(let id=1;id<=3;id++){db.claim(id);db.ready(id,{capture_file:'photo-'+id,capture:{state:'UNKNOWN',gameRunning:id===2,manualReview:true,replayableRoot:true,requiresLive:false}});}
  db.commit(3,[{x:.2,y:.3}]);
  assert.equal(db.refreshStartupAdapters(),1);assert.equal(db.getTask(1).status,'queued');
  assert.equal(db.getTask(2).status,'ready');assert.equal(db.getTask(3).status,'annotated');assert.equal(db.marksForTask(3).length,1);
  db.claim(1);db.ready(1,{capture_file:'photo-1',capture:{gameRunning:false,manualReview:true,replayableRoot:true}});
  assert.equal(db.refreshStartupAdapters(),0);assert.equal(db.getTask(1).status,'ready');
 }finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
