import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';

test('review flags persist across restart without consuming a capture or its marks',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-review-'));let db=new CatalogDB(dir);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.importUrls(['https://www.pragmaticplay.fun/en/slots/test/']);
 db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE'}});
 db.setReview(1,true);assert.ok(db.gameProgress()[0].reviewRequestedAt);
 assert.equal(db.getTask(1).status,'ready');assert.equal(db.marksForTask(1).length,0);
 db.close();db=new CatalogDB(dir);assert.ok(db.gameProgress()[0].reviewRequestedAt);
 db.setReview(1,false);assert.equal(db.gameProgress()[0].reviewRequestedAt,null);
 assert.throws(()=>db.setReview(999,true),/not found/i);
 assert.throws(()=>db.setReview(1,'false'),/boolean/i);
});

test('provider history preserves branching coordinates, closed paths and unapplied actions',async t=>{
 const {exportHistory,historyCsv}=await import('../src/history.js');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-history-')),db=new CatalogDB(dir);
 t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 db.importUrls(['https://www.pragmaticplay.fun/en/slots/test/','https://demo.bgaming-network.com/play/Test/FUN?server=demo']);
 db.claim(1);db.ready(1,{capture_file:'x',capture:{state:'BASE',width:1000,height:600,clip:{x:10,y:20,width:1000,height:600}}});
 const [a,b]=db.commit(1,[{x:.2,y:.3,label:'Menu'},{x:.8,y:.4,kind:'antebet',label:'Extra'}]).children;
 db.claim(a.taskId);db.ready(a.taskId,{capture_file:'y',capture:{state:'UNKNOWN',actionApplied:false,width:1000,height:600}});
 const [c]=db.commit(a.taskId,[{x:.4,y:.6,label:'Compra'}]).children;
 db.claim(b.taskId);db.ready(b.taskId,{capture_file:'z',capture:{state:'UNKNOWN',actionApplied:false}});db.finish(b.taskId);db.setReview(1,true);
 const out=exportHistory(db,{provider:'pragmatic',reviewOnly:true});
 assert.equal(out.games.length,1);const g=out.games[0];assert.equal(g.id,1);assert.ok(g.reviewRequestedAt);
 const route=g.routes.find(x=>x.taskId===c.taskId);assert.equal(route.steps.length,2);
 assert.deepEqual(route.steps.map(x=>[x.x,x.y]),[[.2,.3],[.4,.6]]);
 assert.equal(route.steps[0].applied,false);assert.deepEqual(route.steps[0].imagePixel,{x:200,y:180});
 assert.equal(g.routes.find(x=>x.taskId===b.taskId).status,'completed');
 assert.equal(g.antebets.completed,0);assert.equal(exportHistory(db,{provider:'bgaming',reviewOnly:true}).games.length,0);
 const csv=historyCsv(out);assert.match(csv,/coordenadas|rutas/i);assert.match(csv,/Menu/);assert.match(csv,/0.2/);
 db.db.prepare('UPDATE games SET name=? WHERE id=1').run('=WEBSERVICE("bad")');
 assert.match(historyCsv(exportHistory(db)),/'=WEBSERVICE/);
});
