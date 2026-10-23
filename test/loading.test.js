import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserEngine} from '../src/browser.js';

const view=(state,controls=[],loading=false)=>({state,controls,signature:`${state}|${controls.map(c=>c.path).join('|')}`,scan:{supported:state!=='UNKNOWN',loading},clip:{x:0,y:0,width:1000,height:600}});
const introControl={path:'GameRoot/IntroScreen/PlayButtonIntro',hit:{x:.4,y:.5,w:.1,h:.1}};

test('a known active spin keeps waiting past the manual-review threshold',async()=>{
  const engine=new BrowserEngine({manualReviewAfterMs:1},null);let reads=0;
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>({...view(++reads<12?'UNKNOWN':'BASE',[{path:reads<12?'StopSpin_Button':'StartSpin_Button',hit:{x:0,y:0,w:.1,h:.1}}]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'});
  const result=await engine.waitForGameReady({},{allowManual:true,timeoutMs:300,stableMs:1,pollMs:1});
  assert.equal(result.state,'BASE');assert.equal(result.manualReview,undefined);assert.ok(reads>=12);
});

test('post-click cooldown prevents publishing an unchanged screen too early',async()=>{
  const engine=new BrowserEngine({},null);engine.dismissConsent=async()=>{};
  engine.observe=async()=>view('BASE',[introControl]);
  const deadline=Date.now()+35;
  await engine.waitForGameReady({readyNotBefore:deadline},{timeoutMs:300,stableMs:1,pollMs:1});
  assert.ok(Date.now()>=deadline);
});

test('an operator click establishes a 4.5 second cooldown and three-second stability wait',async()=>{
  const engine=new BrowserEngine({},null),current={...view('UNKNOWN',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'};
  engine.observe=async()=>current;
  let clickedAt=0;
  const session={manualToken:'test',page:{mouse:{click:async()=>{clickedAt=Date.now();}}}};
  engine.waitForGameReady=async(s,options)=>{
    assert.ok(s.readyNotBefore>=clickedAt+4500);assert.equal(options.stableMs,3000);return view('BASE',[introControl]);
  };
  await engine.clickMark(session,{...current,manualReview:true,manualToken:'test'},{x:.5,y:.5,kind:'click'});
});

test('an unrecognized demo screen can be handed to the operator instead of failing',async()=>{
  const engine=new BrowserEngine({manualReviewAfterMs:1},null);engine.dismissConsent=async()=>{};
  engine.observe=async()=>({...view('INTRO',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'});
  const result=await engine.waitForGameReady({},{allowManual:true,timeoutMs:50,stableMs:1,pollMs:1});
  assert.equal(result.manualReview,true);assert.match(result.manualReason,/manual/i);
});

test('a manual capture accepts an operator coordinate on its original session without runtime detection',async()=>{
  const engine=new BrowserEngine({},null);let clicks=0;
  const current={...view('UNKNOWN',[]),frameUrl:'https://demogamesfree.pragmaticplay.net/fixture'};
  engine.observe=async()=>current;
  engine.waitForGameReady=async(s,options)=>{assert.equal(options.expectedCapture,undefined);return view('BASE',[introControl]);};
  const session={manualToken:'same-session',page:{mouse:{click:async(x,y)=>{assert.equal(x,500);assert.equal(y,300);clicks++;}}}};
  await engine.clickMark(session,{...current,manualReview:true,manualToken:'same-session'},{x:.5,y:.5,kind:'click'});
  assert.equal(clicks,1);
});

test('manual coordinates are never applied to a different session',async()=>{
  const engine=new BrowserEngine({},null);
  await assert.rejects(()=>engine.clickMark({manualToken:'other'},
    {manualReview:true,manualToken:'original'},{x:.5,y:.5,kind:'click'}),{code:'MANUAL_SESSION_REQUIRED'});
});

test('loading waits through transient base controls and opens the late intro before returning',async t=>{
  const engine=new BrowserEngine({},null);
  // Read progression, rather than OS scheduling delays under a busy browser,
  // determines how long the simulated transient screen was visible.
  let ticks=0;t.mock.method(Date,'now',()=>ticks);
  let reads=0,opened=false;
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>{reads++;ticks+=5;return reads<=2?view('BASE',[{path:'StartSpin_Button',hit:{x:0,y:0,w:.1,h:.1}}]):opened?view('BASE',[{path:'StartSpin_Button',hit:{x:0,y:0,w:.1,h:.1}}]):view('INTRO',[introControl]);};
  const session={page:{mouse:{click:async(x,y)=>{assert.equal(x,450);assert.equal(y,330);opened=true;}}}};
  const result=await engine.waitForGameReady(session,{timeoutMs:1500,stableMs:15,pollMs:2});
  assert.equal(result.state,'BASE');
  assert.equal(opened,true);
});

test('loading timeout rejects an intro with no verified start button',async()=>{
  const engine=new BrowserEngine({},null);
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>view('INTRO',[]);
  await assert.rejects(()=>engine.waitForGameReady({},{timeoutMs:25,stableMs:5,pollMs:1}),{code:'GAME_NOT_READY'});
  assert.equal(engine.metrics.screenshots,0);
});

test('screenshot refuses a loading state instead of publishing it as ready',async()=>{
  const engine=new BrowserEngine({},null);
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>view('INTRO',[introControl]);
  await assert.rejects(()=>engine.screenshot({},1),{code:'GAME_NOT_READY'});
});

test('runtime controls without visible hit areas do not finish loading',async()=>{
  const engine=new BrowserEngine({},null);
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>view('BASE',[{path:'StartSpin_Button',hit:null}]);
  await assert.rejects(()=>engine.waitForGameReady({},{timeoutMs:25,stableMs:5,pollMs:1}),{code:'GAME_NOT_READY'});
});

test('base controls behind a slow loader cannot bypass the late intro',async()=>{
  const engine=new BrowserEngine({},null);
  const started=Date.now();let opened=false;
  engine.dismissConsent=async()=>{};
  const baseControls=[{path:'StartSpin_Button',hit:{x:0,y:0,w:.1,h:.1}}];
  engine.observe=async()=>Date.now()-started<80?view('BASE',baseControls,true):opened?view('BASE',baseControls):view('INTRO',[introControl]);
  const session={page:{mouse:{click:async()=>{opened=true;}}}};
  const result=await engine.waitForGameReady(session,{timeoutMs:1500,stableMs:15,pollMs:2});
  assert.equal(result.state,'BASE');
  assert.equal(opened,true,'must wait for the loader and dismiss the intro');
});

test('screenshot refuses base controls still covered by the loader',async()=>{
  const engine=new BrowserEngine({},null);
  engine.dismissConsent=async()=>{};
  engine.observe=async()=>view('BASE',[{path:'StartSpin_Button',hit:{x:0,y:0,w:.1,h:.1}}],true);
  await assert.rejects(()=>engine.screenshot({},1),{code:'GAME_NOT_READY'});
});
