import test from 'node:test';import assert from 'node:assert/strict';
import {proPublicUrl} from '../src/pro_public_url.js';
test('new product links are direct while old-host fallback keeps its original namespace',()=>{
 for(const path of ['/offert','/villkor','/angra','/konto/agare']) {
  assert.equal(proPublicUrl({PRO_SITE_URL:'https://materialraknaren.se/'},path),'https://materialraknaren.se'+path);
  assert.equal(proPublicUrl({},path),'https://stahledigital.se/verkstaden/materialraknaren'+path);
 }
 assert.throws(()=>proPublicUrl({},'//evil.test'),/product path/);
 assert.throws(()=>proPublicUrl({},'/api/pro'),/product path/);
});
