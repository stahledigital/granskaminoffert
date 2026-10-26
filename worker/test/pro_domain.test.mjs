import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleKonto} from '../src/pro_konto.js';

test('domain transition keeps both exact origins and still rejects forged or missing proof before storage',async()=>{
  const config=readFileSync(new URL('../wrangler.toml',import.meta.url),'utf8');
  const allowed=/^PRO_ALLOWED_ORIGIN\s*=\s*"([^"]+)"/m.exec(config)?.[1];
  assert.deepEqual(allowed.split(','),['https://stahledigital.se','https://materialraknaren.se']);
  let touched=0;
  const env={PRO_KONTO:'inbjudna',PRO_ALLOWED_ORIGIN:allowed,
    get PRO_REGISTER(){touched++;throw Error('No storage expected')},
    get PRO_KONTON(){touched++;throw Error('No storage expected')}};
  for(const origin of allowed.split(',')) {
    const jobs=[];
    const r=await handleKonto(new Request('https://api.invalid/pro/konto/kod',{method:'POST',headers:{Origin:origin,'X-MR-Pro':'1','Content-Type':'application/json'},body:'{}'}),env,{waitUntil:p=>jobs.push(p)});
    await Promise.all(jobs);
    assert.equal(r.status,202);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
    assert.match(r.headers.get('Cache-Control'),/no-store/);
  }
  for(const headers of [{Origin:'https://materialraknaren.se.evil.test','X-MR-Pro':'1'},
    {Origin:'https://materialraknaren.se'},{'X-MR-Pro':'1'},{Origin:'https://www.materialraknaren.se','X-MR-Pro':'1'}]) {
    const r=await handleKonto(new Request('https://api.invalid/pro/konto/kod',{method:'POST',headers,body:'{}'}),env,{});
    assert.equal(r.status,403);
  }
  assert.equal(touched,0);
});
