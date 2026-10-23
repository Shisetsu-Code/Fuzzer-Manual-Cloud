import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {dismissEntryOverlays} from '../src/entry-overlays.js';
import {BrowserEngine} from '../src/browser.js';
import {readEntryIssue} from '../src/entry-issues.js';

test('custom provider age and cookie controls dismiss only explicit entry notices',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();
  for(const [html,expected] of [
   ['<div class="popup"><p>Please verify that you are over 18 years old</p><div onclick="this.parentElement.remove()">YES, I AM OVER 18</div></div>',{cookies:0,age:1}],
   ['<div class="popup"><p onclick="this.parentElement.remove()">Yes, I am over 18</p></div>',{cookies:0,age:1}],
   ['<div class="popup"><p>Please confirm that you are 18 or older</p><p onclick="this.parentElement.remove()">I Am 18 Or Older!</p></div>',{cookies:0,age:1}],
   ['<div class="overlay"><p>By confirming below you agree to be of legal age in your country.</p><a onclick="this.parentElement.remove()">YES, I AM</a></div>',{cookies:0,age:1}],
   ['<div class="popup"><p>You must be over the legal gambling age. Please confirm the age requirement.</p><button onclick="this.parentElement.remove()">YES, I AM 18+</button></div>',{cookies:0,age:1}],
   ['<div><p>We use cookies to track usage and improve the website.</p><span role="button" onclick="this.parentElement.remove()">I ACCEPT</span></div>',{cookies:1,age:0}],
   ['<div><p>Confirm purchase: total bet 18, balance 1000</p><button>Yes</button><button>I accept</button></div>',{cookies:0,age:0}],
   ['<div class="age-gate"><p>Please verify your age</p><input type="date"><button>Confirm</button></div>',{cookies:0,age:0}]
  ]){await page.setContent(html);assert.deepEqual(await page.evaluate(dismissEntryOverlays),expected,html);}
 }finally{await browser.close();}
});

test('entry issues distinguish security blocks and missing pages from a game or hidden contact form',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();for(const [html,expected] of [
  ['<h1>Performing security verification</h1><p>Verify you are human</p>','HUMAN_VERIFICATION'],
  ['<h1>Access Denied</h1>','ACCESS_DENIED'],['<h1>Oops! Page Not Found</h1>','PAGE_NOT_FOUND'],
  ['<p>Please verify your age</p><input type="date">','AGE_DETAILS_REQUIRED'],
  ['<h1>Game</h1><div hidden>Verify your age<input type="date"></div>',null],
  ['<p>Balance 1000 Bet 10</p><iframe title="hcaptcha" style="display:none"></iframe>',null]
 ]){await page.setContent(html);assert.equal(await page.evaluate(readEntryIssue),expected);}}
 finally{await browser.close();}
});

test('a slow demo launch button is clicked once instead of toggling its modal closed',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();
  await page.route('https://www.thunderkick.com/**',route=>route.fulfill({contentType:'text/html',body:'<button onclick="window.clicks=(window.clicks||0)+1;window.opened=window.opened?0:Date.now()">Play Game</button>'}));
  const engine=new BrowserEngine({entryTimeoutMs:6000},null);
  engine.observeGeneric=async()=>{assert.ok((await page.evaluate(()=>window.clicks||0))<2,'launcher must not toggle twice');const ready=await page.evaluate(()=>window.opened&&Date.now()-window.opened>2500);return {entryReview:!ready,frameUrl:ready?'https://demo.example/game':null};};
  engine.ensureGenericStarted=async()=>engine.observeGeneric();engine.dismissConsent=async()=>{};
  await engine.enterGeneric({url:'https://www.thunderkick.com/games/test/',page});
  assert.equal(await page.evaluate(()=>window.clicks),1);
 }finally{await browser.close();}
});

test('embedded demo is centered fully, while a hidden game modal is ignored',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage({viewport:{width:1280,height:720}}),url='https://3oaks.com/game/fixture';
  await page.route('https://3oaks.com/**',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('/api/')?'<style>html,body{margin:0;height:100%}canvas{width:100%;height:100%}</style><canvas></canvas>':'<div style="height:500px"></div><iframe style="width:920px;height:572px;border:0" src="/api/v1/games/fixture/play"></iframe><div style="height:500px"></div>'}));
  await page.goto(url);await page.frameLocator('iframe').locator('canvas').waitFor();
  const engine=new BrowserEngine({viewportWidth:1280,viewportHeight:720},null),session={url,page};
  const view=await engine.observeGeneric(session);assert.equal(view.entryReview,undefined);assert.ok(view.clip.height>=550);assert.ok(view.clip.y+view.clip.height<=720);
  await page.locator('iframe').evaluate(el=>el.style.opacity='0');
  assert.equal((await engine.observeGeneric(session)).entryReview,true);
 }finally{await browser.close();}
});

test('server-rendered launch buttons wait for client handlers before the only click',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();
  await page.route('https://amusnetgaming.com/**',route=>route.fulfill({contentType:'text/html',body:'<button id="demo">Play Demo</button><script>setTimeout(()=>document.getElementById("demo").onclick=()=>window.opened=true,500)</script>'}));
  const engine=new BrowserEngine({entryTimeoutMs:2800,entryLaunchDelayMs:800},null);
  engine.observeGeneric=async()=>({entryReview:!await page.evaluate(()=>window.opened),frameUrl:await page.evaluate(()=>window.opened)?'https://demo.example/game':null});
  engine.ensureGenericStarted=async()=>engine.observeGeneric();engine.dismissConsent=async()=>{};
  await engine.enterGeneric({url:'https://amusnetgaming.com/games/online-casino/test/',page});assert.equal(await page.evaluate(()=>window.opened),true);
 }finally{await browser.close();}
});
