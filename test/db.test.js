import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
const A='https://www.pragmaticplay.fun/en/slots/candy-rush/';
function fixture(fn){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuzz-manual-'));const db=new CatalogDB(dir,{sqliteCacheMb:8});try{fn(db)}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}}
test('import deduplicates game URLs and roots',()=>fixture(db=>{
  assert.deepEqual(db.importUrls([A,A]),{added:1,existing:0,unique:1});
  assert.deepEqual(db.importUrls([A]),{added:0,existing:1,unique:1});
  assert.equal(db.stats().games,1);
}));

test('manual fallback requeues only unread failed roots, never a previous action',()=>fixture(db=>{
  db.importUrls([A,'https://www.pragmaticplay.fun/en/slots/gates-of-olympus/']);
  db.fail(1,'failed','GAME_NOT_READY: INTRO');
  db.claim(2);db.ready(2,{capture_file:'kept.jpg',capture:{state:'BASE'}});
  const child=db.commit(2,[{x:.5,y:.5,kind:'navigate'}]).children[0];db.fail(child.taskId,'failed','GAME_NOT_READY: UNKNOWN');
  assert.equal(db.retryUnreadRoots(),1);assert.equal(db.getTask(1).status,'queued');
  assert.equal(db.getTask(child.taskId).status,'failed');assert.equal(db.getTask(2).status,'annotated');
}));
test('one photograph forks into four persisted, independent queued tasks',()=>fixture(db=>{
  db.importUrls([A]);const task=db.nextQueued();assert.equal(db.claim(task.id),true);
  db.ready(task.id,{capture_file:'/tmp/fake.jpg',capture:{state:'BUY_MENU',clip:{x:0,y:0,width:800,height:600}}});
  const marks=[{x:.2,y:.2,kind:'buy'},{x:.8,y:.2,kind:'buy'},{x:.2,y:.8,kind:'buy'},{x:.8,y:.8,kind:'buy'}];
  const commit=db.commit(task.id,marks);
  assert.equal(commit.children.length,4);
  assert.equal(db.stats().tasks.queued,4);
  assert.equal(db.stats().marks,4);
  assert.equal(db.lineage(commit.children[3].taskId)[0].mark.x,.8);
  assert.notEqual(commit.children[0].markId,commit.children[1].markId);
  assert.throws(()=>db.commit(task.id,marks),/already cataloged/);
}));
test('restart retains screenshots, marks and requeues interrupted preparations',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fuzz-manual-reopen-'));
  try{
    let db=new CatalogDB(dir,{sqliteCacheMb:8});db.importUrls([A]);const first=db.nextQueued();db.claim(first.id);db.close();
    db=new CatalogDB(dir,{sqliteCacheMb:8});assert.equal(db.nextQueued().id,first.id);db.close();
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('startup replaces lost bonus sessions with one fresh root while preserving history',()=>fixture(db=>{
  db.importUrls([A]);const root=db.nextQueued();db.claim(root.id);
  db.ready(root.id,{capture_file:'old.jpg',capture:{state:'BONUS',requiresLive:true,controls:[]}});
  const child=db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]).children[0];
  const first=db.recoverLostSessions();
  assert.equal(db.getTask(child.taskId).status,'blocked');
  assert.match(db.getTask(child.taskId).error,/LIVE_SESSION_LOST/);
  assert.equal(db.marksForTask(root.id).length,1);assert.equal(first.roots,1);
  assert.equal(db.nextQueued().depth,0);assert.notEqual(db.nextQueued().id,root.id);
  assert.equal(db.recoverLostSessions().roots,0);
}));

test('a legacy ready BASE after a spin is also recognized as a lost live session',()=>fixture(db=>{
  db.importUrls([A]);const root=db.nextQueued();db.claim(root.id);
  db.ready(root.id,{capture_file:'base.jpg',capture:{state:'BASE',controls:[{path:'StartSpin_Button',hit:{x:.4,y:.4,w:.2,h:.2}}]}});
  const child=db.getTask(db.commit(root.id,[{x:.5,y:.5,kind:'navigate'}]).children[0].taskId);
  db.claim(child.id);db.ready(child.id,{capture_file:'old-spin.jpg',capture:{state:'BASE',controls:[]}});
  const result=db.recoverLostSessions();
  assert.equal(db.getTask(child.id).status,'blocked');assert.equal(result.roots,1);
  assert.equal(db.marksForTask(root.id).length,1);
}));
test('old entry photos refresh once without replaying marked routes or changing provider turns',()=>fixture(db=>{
 db.importUrls([A,'https://www.pragmaticplay.fun/en/slots/gates-of-olympus/','https://www.pragmaticplay.fun/en/slots/sweet-bonanza/']);
 const entry={state:'UNKNOWN',manualReview:true,entryReview:true,replayableRoot:true,requiresLive:false};
 for(let id=1;id<=3;id++){db.claim(id);db.ready(id,{capture_file:'original-'+id,capture:id===2?{state:'BASE'}:entry});}
 const child=db.commit(3,[{x:.5,y:.5,kind:'click'}]).children[0];db.claim(child.taskId);db.ready(child.taskId,{capture_file:'child-photo',capture:entry});
 db.setSetting('provider-next:pragmatic',123456);
 assert.equal(db.refreshEntryReviews(),1);assert.equal(db.getTask(1).status,'queued');assert.equal(db.getTask(1).capture_file,'original-1');
 assert.equal(db.getTask(2).status,'ready');assert.equal(db.getTask(3).status,'annotated');assert.equal(db.getTask(child.taskId).status,'ready');
 assert.equal(db.getSetting('provider-next:pragmatic'),123456);assert.equal(db.refreshEntryReviews(),0);
}));
