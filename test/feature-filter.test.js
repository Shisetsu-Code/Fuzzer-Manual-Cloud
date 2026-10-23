import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {featureFilter} from '../src/feature-filter.js';

test('only positive confirmed counts qualify; unknown, missing and empty stay out',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fm-filter-'));
  try{
    const file=path.join(dir,'catalog.json'),filter=featureFilter(file);
    assert.equal(filter({slug:'buy'}),false);
    fs.writeFileSync(file,JSON.stringify({source:'Tester-Spin',games:{buy:{purchases:2,antebets:null},ante:{purchases:0,antebets:1},empty:{purchases:0,antebets:0},unknown:{purchases:null,antebets:null},invalid:{purchases:'1'}}}));
    for(const slug of ['buy','ante'])assert.equal(filter({slug}),true);
    for(const slug of ['empty','unknown','missing','invalid'])assert.equal(filter({slug}),false);
    fs.writeFileSync(file,'broken');fs.utimesSync(file,new Date(),new Date(Date.now()+1000));
    assert.equal(filter({slug:'buy'}),false);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
