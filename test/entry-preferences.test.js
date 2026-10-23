import test from 'node:test';
import assert from 'node:assert/strict';
import {preferenceState} from '../src/entry-overlays.js';
test('only cookie/age preferences survive, never demo sessions, authentication or game state',()=>{
  const rows=['OptanonConsent','CookieConsent','cookieyes-consent','ageVerified','age-gate-accepted','session_cookie','sessionId','authToken','gameState','balance'].map(name=>({name,value:'true'}));
  const state=preferenceState({cookies:rows,origins:[{origin:'https://example.test',localStorage:rows,indexedDB:[{name:'session'}]}]});
  assert.deepEqual(state.cookies.map(r=>r.name),['OptanonConsent','CookieConsent','cookieyes-consent','ageVerified','age-gate-accepted']);
  assert.deepEqual(state.origins[0].localStorage,state.cookies);assert.equal(state.origins[0].indexedDB,undefined);
  assert.deepEqual(preferenceState(null),{cookies:[],origins:[]});
});
