import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {CatalogDB} from '../src/db.js';import {BrowserEngine} from '../src/browser.js';import {describeQueue} from '../src/queue-context.js';
const capture={state:'UNKNOWN',width:1000,height:600,clip:{x:10,y:20,width:1000,height:600},visualKey:Buffer.alloc(576,80).toString('base64'),manualReview:true,requiresLive:true};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ordered-')),db=new CatalogDB(dir);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/']);db.claim(1);db.ready(1,{capture_file:'source.jpg',capture});return db;}
test('right-click points form one ordered operation while left clicks stay independent',t=>{
 const db=fixture(t);const result=db.commit(1,[{x:.1,y:.2,kind:'click'},{x:.3,y:.4,kind:'ordered'},{x:.5,y:.6,kind:'ordered'},{x:.7,y:.8,kind:'click'}]);
 assert.equal(result.children.length,3);assert.deepEqual(result.children.map(c=>c.kind),['click','sequence','click']);
 const mark=db.getMark(result.children[1].markId);assert.deepEqual(mark.steps.map(p=>[p.x,p.y]),[[.3,.4],[.5,.6]]);assert.equal(db.lineage(result.children[1].taskId).at(-1).mark.steps.length,2);
});
test('the second coordinate executes after the first even if the game state changes; a recovery never clicks twice',async()=>{
 const engine=new BrowserEngine({sequenceStepDelayMs:0},{}),points=[];let observations=0,waits=0;
 engine.observe=async()=>{observations++;return {state:observations===1?'BASE':'BONUS',clip:capture.clip};};engine.waitForGameReady=async()=>{waits++;return {state:'BONUS',manualReason:'Review'};};
 const session={page:{mouse:{click:async(x,y)=>points.push([x,y])}}},mark={id:4,steps:[{x:.2,y:.3},{x:.8,y:.7}]};
 await engine.runSequence(session,capture,mark);await engine.runSequence(session,capture,mark);
 assert.deepEqual(points,[[210,200],[810,440]]);assert.equal(session.sequenceFlow.completed.length,2);assert.equal(waits,2);
});
test('an uncertain mouse action is never silently repeated or followed by another step',async()=>{
 const engine=new BrowserEngine({sequenceStepDelayMs:0},{});engine.observe=async()=>({clip:capture.clip});let clicks=0;const session={page:{mouse:{click:async()=>{clicks++;throw Error('connection lost');}}}},mark={id:2,steps:[{x:.2,y:.3},{x:.8,y:.7}]};
 await assert.rejects(()=>engine.runSequence(session,capture,mark),/connection lost/);await assert.rejects(()=>engine.runSequence(session,capture,mark),/SEQUENCE_UNCERTAIN/);assert.equal(clicks,1);assert.equal(session.sequenceFlow.completed.length,0);
});
test('both executed sequence coordinates survive as distinct green marker evidence',t=>{
 const db=fixture(t),child=db.commit(1,[{x:.2,y:.3,kind:'ordered'},{x:.8,y:.7,kind:'ordered'}]).children[0];db.claim(child.taskId);db.ready(child.taskId,{capture_file:'result.jpg',capture:{...capture,actionApplied:true,sequence:{completed:[{x:.2,y:.3,index:1},{x:.8,y:.7,index:2}]}}});
 const item=describeQueue(db,db.listReady())[0];assert.equal(item.previousClicks.length,2);assert.deepEqual(item.previousClicks.map(p=>p.sequenceIndex),[1,2]);
});
