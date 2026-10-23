import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {entryCatalog} from '../src/entry-catalog.js';
import {startupNetworkIssue} from '../src/entry-issues.js';
test('obsolete launch IDs resolve to the original official game page without changing provider',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fm-entry-catalog-')),file=path.join(dir,'catalog.json');
 const original='https://games.evolution.com/demo/15926?showNavbar=true';
 try{
  await fs.writeFile(file,JSON.stringify({source:'Tester-Spin',catalog:[{url:original,launchUrl:'https://games.evolution.com/slots/10001-nights/'}]}));
  assert.equal(await entryCatalog(file)(original),'https://games.evolution.com/slots/10001-nights/');
  await fs.writeFile(file,JSON.stringify({source:'Tester-Spin',catalog:[{url:original,launchUrl:'https://evil.example/demo'}]}));
  assert.equal(await entryCatalog(file)(original),original);
  assert.equal(await entryCatalog(path.join(dir,'missing'))(original),original);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('only a failed required launcher service is classified as an entry blocker',()=>{
 assert.equal(startupNetworkIssue('relax','https://stag-casino-client.api.relaxg.net/capi/2.0/casino/games/getlauncherconfig'),'STARTUP_SERVICE_UNAVAILABLE');
 assert.equal(startupNetworkIssue('relax','https://example.com/logo.png'),null);
 assert.equal(startupNetworkIssue('playngo','https://pc-prod-eu.playngonetwork.com/promotions/player/available'),null);
});
