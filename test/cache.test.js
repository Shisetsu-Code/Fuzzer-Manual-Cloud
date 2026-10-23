import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageCache} from '../src/cache.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
test('LRU bounds in-memory data and updates recency',()=>{
  const c=new ImageCache(8);
  c.put('a',Buffer.alloc(4));c.put('b',Buffer.alloc(4));assert.equal(c.get('a')?.length,4);
  c.put('c',Buffer.alloc(4));assert.equal(c.get('b'),null);assert.ok(c.stats().bytes<=8);
});

test('reprepared screenshots invalidate cached and in-flight images',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fm-image-refresh-')),file=path.join(dir,'photo.jpg'),cache=new ImageCache(1024);
 try{
  await fs.writeFile(file,'old');await cache.load(file);await fs.writeFile(file,'new');cache.invalidate(file);
  assert.equal((await cache.load(file)).toString(),'new');
  cache.clear();const old=cache.load(file);cache.invalidate(file);await old;assert.equal(cache.entries.has(file),false);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
