import test from 'node:test';import assert from 'node:assert/strict';import {chromium} from 'playwright';import {BrowserEngine} from '../src/browser.js';
test('real browser clicks the marked second point after the first replaces the screen',async t=>{
 const browser=await chromium.launch({headless:true,...(process.env.CI?{channel:'chrome'}:{})});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:900,height:600}});
 await page.setContent(`<button id="first" style="position:absolute;left:130px;top:155px;width:100px;height:50px">Antebet</button><script>window.log=[];document.getElementById('first').onclick=()=>{window.log.push('first');const second=document.createElement('button');second.style.cssText='position:absolute;left:670px;top:395px;width:100px;height:50px';second.textContent='Spin';second.onclick=()=>window.log.push(2);document.body.replaceChildren(second);};</script>`);
 const engine=new BrowserEngine({sequenceStepDelayMs:20},{});engine.observe=async()=>({clip:{x:0,y:0,width:900,height:600}});engine.waitForGameReady=async()=>({state:'UNKNOWN'});
 await engine.runSequence({page},{},{id:1,steps:[{x:.2,y:.3},{x:.8,y:.7}]});assert.deepEqual(await page.evaluate(()=>window.log),['first',2]);
});
