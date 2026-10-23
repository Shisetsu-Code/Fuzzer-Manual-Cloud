import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEngine} from '../src/browser.js';
test('canvas in an inherited blank iframe is recognized as part of its public demo',async()=>{
  const url='https://playin.com/embed/v1/demo/AirportSecurity';
  const frame={url:()=> 'about:blank',parentFrame:()=>({url:()=>url}),frameElement:async()=>null,locator:()=>({all:async function(){return [this];},first(){return this;},count:async()=>1,boundingBox:async()=>({x:0,y:0,width:1280,height:720})})};
  const engine=new BrowserEngine({viewportWidth:1280,viewportHeight:720},null);
  const result=await engine.observeGeneric({url,page:{url:()=>url,frames:()=>[frame]}});
  assert.equal(result.frameUrl,url);assert.equal(result.entryReview,undefined);assert.equal(result.clip.width,1280);
});
test('a catalog without a game canvas is explicitly an entry review, never a verified game',async()=>{
  const url='https://quickspin.com/slots/crown-of-valor/',engine=new BrowserEngine({viewportWidth:1280,viewportHeight:720},null);
  const view=await engine.observeGeneric({url,page:{url:()=>url,frames:()=>[]}});
  assert.equal(view.entryReview,true);assert.equal(view.scan.supported,false);assert.equal(view.state,'UNKNOWN');
});

test('an invisible utility canvas cannot mask the visible game canvas',async()=>{
 const url='https://playin.com/embed/v1/demo/AirportSecurity';
 const item=rect=>({boundingBox:async()=>rect});
 const frame={url:()=>url,parentFrame:()=>null,locator:()=>({all:async()=>[item({x:0,y:0,width:0,height:0}),item({x:0,y:0,width:1280,height:720})]})};
 const engine=new BrowserEngine({viewportWidth:1280,viewportHeight:720},null);
 assert.equal((await engine.observeGeneric({url,page:{url:()=>url,frames:()=>[frame]}})).entryReview,undefined);
});

test('a delayed demo popup from the entry context is adopted, while unrelated tabs are ignored',()=>{
 const page=url=>({url:()=>url,isClosed:()=>false});
 const original=page('https://www.pushgaming.com/games/test.html'),advert=page('https://example.com/news');
 const demo=page('https://www.pushgaming.com/games/play/test.html');
 const session={url:original.url(),page:original,context:{pages:()=>[original,advert,demo]}};
 const engine=new BrowserEngine({},null);engine.adoptDemoPopup(session);assert.equal(session.page,demo);
 session.page=original;session.context.pages=()=>[original,advert];engine.adoptDemoPopup(session);assert.equal(session.page,original);
});
test('a generic antebet remains pending and recovery never toggles it twice',async()=>{
  const engine=new BrowserEngine({},null),session={url:'https://demo.bgaming-network.com/play/Test/FUN?server=demo',page:{keyboard:{press:async key=>{assert.equal(key,'Space');spins++;}}}};let clicks=0,spins=0;
  engine.clickMark=async(s,c,m,{onStarted})=>{clicks++;onStarted();};engine.waitForGameReady=async()=>({state:'UNKNOWN'});
  await engine.runAntebet(session,{},{});await engine.runAntebet(session,{},{});
  assert.equal(clicks,1);assert.equal(spins,0);assert.equal(session.antebetFlow.phase,'verify');
});
