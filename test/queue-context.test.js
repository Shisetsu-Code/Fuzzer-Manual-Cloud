import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CatalogDB} from '../src/db.js';
import {describeQueue,sameScreen} from '../src/queue-context.js';
const base={state:'BASE',width:100,height:60,visualKey:Buffer.alloc(576,100).toString('base64')};
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-context-')),db=new CatalogDB(dir);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});db.importUrls(['https://www.pragmaticplay.fun/en/slots/candy-rush/','https://www.pragmaticplay.fun/en/slots/starlight-princess/']);return db;}
const ready=(db,id,capture)=>{db.claim(id);db.ready(id,{capture_file:'shot.jpg',capture});};
test('separate games are independent; a spin result links its parent and shows the executed click',t=>{
 const db=fixture(t);ready(db,1,base);ready(db,2,base);let items=describeQueue(db,db.listReady());assert.equal(items[0].operation.linked,false);
 const child=db.commit(1,[{x:.8,y:.7,kind:'spin',label:'Tirada 1'}]).children[0].taskId;
 ready(db,child,{...base,actionApplied:true});items=describeQueue(db,db.listReady());const result=items.find(i=>i.id===child),other=items.find(i=>i.id===2);
 assert.equal(result.operation.parentId,1);assert.equal(result.operation.label,'Tirada normal');assert.equal(result.spinSummary.executed,1);assert.equal(result.previousClicks.length,1);assert.equal(result.previousClicks[0].x,.8);assert.equal(result.previousClicks[0].onRoute,true);
 assert.equal(other.previousClicks.length,0);assert.equal(other.spinSummary.executed,0);
});
test('pending marks are never shown as executed and different screens never get old pins',t=>{
 const db=fixture(t);ready(db,1,base);const child=db.commit(1,[{x:.8,y:.7,kind:'spin'}]).children[0].taskId;
 ready(db,child,{...base,state:'BONUS',actionApplied:false});const result=describeQueue(db,db.listReady())[0];assert.equal(result.previousClicks.length,0);assert.equal(result.spinSummary.executed,0);assert.equal(result.actionHistory[0].status,'no ejecutado');
 assert.equal(sameScreen(base,{...base,width:101}),false);assert.equal(sameScreen(base,{...base,visualKey:null}),false);assert.equal(sameScreen(base,{...base,visualKey:Buffer.alloc(576,250).toString('base64')}),false);
});
test('independent choices retain distinct operation identifiers and their fresh-session relationship',t=>{
 const db=fixture(t);ready(db,1,{...base,requiresLive:true});const children=db.commit(1,[{x:.2,y:.3,kind:'buy'},{x:.7,y:.3,kind:'buy'}]).children;
 for(const c of children)ready(db,c.taskId,{...base,actionApplied:true});const items=describeQueue(db,db.listReady());assert.equal(items.length,2);assert.notEqual(items[0].operation.id,items[1].operation.id);assert.equal(items[0].game_id,items[1].game_id);assert.equal(items[0].operation.linked,true);assert.equal(items[0].operation.freshStart,true);
});
test('an observational refresh preserves proof that the earlier spin executed',t=>{
 const db=fixture(t);ready(db,1,{...base,actionApplied:true});db.refreshReady(1,{file:'new.jpg',capture:{...base,actionApplied:false}});assert.equal(JSON.parse(db.getTask(1).capture_json).actionApplied,true);
});

test('stable runtime controls can match the same screen even when reel symbols changed',()=>{
 assert.equal(sameScreen({...base,signature:'BASE|Spin_Button'},{...base,signature:'BASE|Spin_Button',visualKey:Buffer.alloc(576,200).toString('base64')}),true);
 assert.equal(sameScreen({...base,signature:'manual|host|100|60'},{...base,signature:'manual|host|100|60',visualKey:Buffer.alloc(576,200).toString('base64')}),false);
});
test('repeated queue entries cannot show two images for one game operation',t=>{
 const db=fixture(t);ready(db,1,base);const item=db.listReady()[0];assert.equal(describeQueue(db,[item,item]).length,1);
});

test('the last executed click remains visible on its result even when the reels and state changed',t=>{
 const db=fixture(t);ready(db,1,{...base,frameUrl:'https://demo.example/game'});const child=db.commit(1,[{x:.8,y:.7,kind:'spin'}]).children[0].taskId;
 ready(db,child,{...base,state:'BONUS',visualKey:Buffer.alloc(576,240).toString('base64'),actionApplied:true});const result=describeQueue(db,db.listReady())[0];assert.equal(result.previousClicks.length,1);assert.equal(result.previousClicks[0].sameScreen,false);assert.equal(result.previousClicks[0].lastAction,true);assert.equal(result.previousClicks[0].x,.8);
});
