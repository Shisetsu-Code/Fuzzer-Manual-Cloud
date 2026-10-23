import test from 'node:test';
import assert from 'node:assert/strict';
import {ProviderLimits} from '../src/provider-limits.js';
import {providerFor,publicDemoUrl,PROVIDERS} from '../src/providers.js';

test('provider cooldown persists, isolates providers, and admits only one job per minute',()=>{
  const settings=new Map(),db={getSetting:(k,d)=>settings.get(k)??d,setSetting:(k,v)=>settings.set(k,v)};let now=100000;
  let limits=new ProviderLimits(db,{now:()=>now});const a={provider:'bgaming'},b={provider:'hacksaw'};
  assert.equal(limits.allowed(a,{}),true);limits.reserve(a);
  assert.equal(limits.allowed(a,{}),false);assert.equal(limits.allowed(b,{}),true);
  limits=new ProviderLimits(db,{now:()=>now});now+=59999;assert.equal(limits.allowed(a,{}),false);
  now++;assert.equal(limits.allowed(a,{}),true);
});
test('provider root capacity preserves limits without freezing live continuations',()=>{
  const db={getSetting:(k,d)=>d};const limits=new ProviderLimits(db),task={provider:'hacksaw'};
  assert.equal(limits.allowed(task,{hacksaw:{games:100,captures:30}}),false);
  assert.equal(limits.allowed({...task,parent_task_id:1},{hacksaw:{games:100,captures:30}}),true);
  assert.equal(limits.allowed({...task,parent_task_id:1},{hacksaw:{games:1,captures:100}}),true);
  assert.equal(limits.allowed(task,{bgaming:{games:100,captures:100}}),true);
});
test('all Tester Spin provider authorities are registered and arbitrary hosts stay rejected',()=>{
  assert.equal(Object.keys(PROVIDERS).length,26);
  const url='https://demo.bgaming-network.com/play/Test/FUN?server=demo';
  assert.equal(providerFor(url),'bgaming');assert.equal(publicDemoUrl(url),url);
  for(const value of ['https://evil.example/demo','https://demo.bgaming-network.com.evil.example/play','https://demo.bgaming-network.com/play/Test?real=1','https://user:pass@bgaming.com/games'])assert.throws(()=>publicDemoUrl(value));
});
test('classification does not consume or wait for a new-game launch turn',()=>{
 const settings=new Map(),db={getSetting:(k,d)=>settings.get(k)??d,setSetting:(k,v)=>settings.set(k,v)};
 const limits=new ProviderLimits(db,{now:()=>100000}),root={provider:'pragmatic'},action={provider:'pragmatic',parent_task_id:7};
 limits.reserve(action);assert.equal(limits.allowed(root,{}),true);
 limits.reserve(root);assert.equal(limits.allowed(root,{}),false);assert.equal(limits.allowed(action,{}),true);
});

test('legacy Amusnet game links use the current official game page path',()=>{
 assert.equal(publicDemoUrl('https://amusnetgaming.com/10-bulky-fruits'),'https://amusnetgaming.com/games/online-casino/10-bulky-fruits');
 assert.equal(publicDemoUrl('https://amusnetgaming.com/online-casino'),'https://amusnetgaming.com/online-casino');
});
