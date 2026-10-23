import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';

test('a game can only finish after its other routes and unresolved failures are closed',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-game-finish-'));const db=new CatalogDB(dir);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);
  db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE'}});
  const children=db.commit(1,[{x:.2,y:.2},{x:.5,y:.5}]).children;
  assert.throws(()=>db.finishGame(1),/pendiente/i);
  db.claim(children[0].taskId);db.ready(children[0].taskId,{capture_file:'x',capture:{state:'BASE'}});
  db.fail(children[1].taskId,'failed','CONTROL_MISSING');
  assert.throws(()=>db.finishGame(1,children[0].taskId),/pendiente/i);
  db.finish(children[1].taskId);assert.equal(db.gameProgress()[0].pendingPaths,1);
  db.finishGame(1,children[0].taskId);
  const progress=db.gameProgress()[0];assert.ok(progress.finishedAt);assert.equal(progress.pendingPaths,0);
  assert.equal(db.getTask(children[0].taskId).status,'completed');assert.equal(db.bufferRoots().length,0);
});

test('closing one capture archives its analysis and preserves every other branch and image',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-finish-'));const db=new CatalogDB(dir);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);
  db.claim(1);db.ready(1,{capture_file:'kept.jpg',capture:{state:'BASE'}});
  const children=db.commit(1,[{x:.2,y:.2},{x:.5,y:.5}]).children;
  for(const c of children){db.claim(c.taskId);db.ready(c.taskId,{capture_file:'kept.jpg',capture:{state:'BASE'}});}
  db.finish(children[0].taskId);
  assert.equal(db.getTask(children[0].taskId).status,'completed');
  assert.equal(db.getTask(children[0].taskId).capture_file,'kept.jpg');
  assert.equal(db.getTask(children[1].taskId).status,'ready');
  assert.equal(db.gameProgress()[0].closedCaptures,1);
  assert.throws(()=>db.commit(children[0].taskId,[]),/already cataloged/);
});

test('ordinary antebet toggle and spin clicks count one manual antebet test without an automatic spin',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-manual-'));const db=new CatalogDB(dir);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/gates-of-olympus/']);
  const control=(path,texts=[])=>({path,texts,hit:{x:.4,y:.4,w:.2,h:.2}});
  db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE',controls:[control('Game/BetLevel/Level_0',['OFF'])]}});
  const toggle=db.commit(1,[{x:.5,y:.5,kind:'click'}]).children[0];assert.equal(toggle.kind,'antebet_toggle');
  const spinControl=control('Game/StartSpin_Button');spinControl.hit.x=.7;
  db.claim(toggle.taskId);db.ready(toggle.taskId,{capture_file:'x',capture:{state:'BASE',controls:[control('Game/BetLevel/Level_1',['ON']),spinControl]}});
  assert.equal(db.gameProgress()[0].antebets.completed,0);
  const spin=db.commit(toggle.taskId,[{x:.8,y:.5,kind:'click'}]).children[0];
  db.claim(spin.taskId);db.ready(spin.taskId,{capture_file:'x',capture:{state:'BASE'}});
  assert.equal(db.gameProgress()[0].antebets.completed,1);
});

test('progress counts confirmed purchases once and only antebets whose spin completed',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-progress-'));const db=new CatalogDB(dir);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);
  function save(id,capture){db.claim(id);db.ready(id,{capture_file:'fixture.jpg',capture});}
  save(1,{state:'BUY_MENU'});
  const branches=db.commit(1,[{x:.1,y:.1,kind:'buy'},{x:.2,y:.2,kind:'buy'},{x:.3,y:.3,kind:'antebet'},{x:.4,y:.4,kind:'antebet'}]).children;
  save(branches[0].taskId,{state:'CONFIRM',requiresLive:true});
  let p=db.gameProgress()[0];assert.equal(p.purchases.completed,0);assert.equal(p.purchases.pending,2);
  const confirm=db.commit(branches[0].taskId,[{x:.5,y:.5,kind:'confirm'}]).children[0];
  save(confirm.taskId,{state:'BONUS',requiresLive:true});
  const next=db.commit(confirm.taskId,[{x:.5,y:.5,kind:'continue'}]).children[0];save(next.taskId,{state:'BASE'});
  save(branches[2].taskId,{state:'BASE',antebet:{phase:'done'}});
  save(branches[3].taskId,{state:'BUY_MENU',antebet:{phase:'close'}});
  p=db.gameProgress()[0];
  assert.deepEqual(p.purchases,{marked:2,completed:1,pending:1,problems:0});
  assert.deepEqual(p.antebets,{marked:2,completed:1,pending:1,problems:0});
  db.fail(branches[1].taskId,'blocked','CONTROL_MISSING');
  p=db.gameProgress()[0];assert.equal(p.purchases.problems,1);assert.equal(p.purchases.pending,0);
  db.recoverLostSessions();assert.equal(db.gameProgress()[0].purchases.completed,1);
});

test('progress infers historical navigation confirmations and includes games with zero marks',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-progress-'));let db=new CatalogDB(dir);
  t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
  db.importUrls(['https://www.pragmaticplay.fun/en/slots/gates-of-olympus/','https://www.pragmaticplay.fun/en/slots/sweet-bonanza/']);
  db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE'}});
  const b=db.commit(1,[{x:.5,y:.5,kind:'buy'}]).children[0];db.claim(b.taskId);
  db.ready(b.taskId,{capture_file:'x',capture:{state:'CONFIRM',controls:[{path:'Game/ConfirmPurchaseWindow/AcceptButton',hit:{x:.4,y:.4,w:.2,h:.2}}]}});
  const c=db.commit(b.taskId,[{x:.5,y:.5,kind:'navigate'}]).children[0];
  db.db.prepare("UPDATE marks SET kind='navigate' WHERE id=?").run(c.markId);
  db.claim(c.taskId);db.ready(c.taskId,{capture_file:'x',capture:{state:'BONUS'}});
  db.close();db=new CatalogDB(dir);
  const rows=db.gameProgress();assert.equal(rows.length,2);
  assert.equal(rows.find(r=>r.slug==='gates-of-olympus').purchases.completed,1);
  assert.equal(rows.find(r=>r.slug==='sweet-bonanza').antebets.marked,0);
});
