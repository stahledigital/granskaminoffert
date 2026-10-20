import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import worker from '../src/index.js';import {ProKonto,ProRegister,register,epostHash} from '../src/pro_konto.js';import {sqlState,namnrymd}from './helpers/pro_do_dubbel.mjs';import {ENV}from './stripe_dubbel.mjs';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/r77-project2.json',import.meta.url),'utf8')),cp=structuredClone,id=fixture.projektId,old=()=>({format:fixture.format,version:1,projektId:id,projektnamn:'Old writer',material:[],arbete:[],ovrigt:[]});
function method(){const state=sqlState(),obj=new ProKonto(state,{});return {state,obj,rows:()=>state.storage.sql.exec('SELECT * FROM projekt').toArray()}}
const data=p=>({ms:Date.now(),id,rev:0,data:JSON.stringify(p),namn:p.projektnamn||'',storlek:Buffer.byteLength(JSON.stringify(p))});
test('DO stored project2 blocks a fresh-revision V1 downgrade and preserves all data and binding',()=>{
 const {state,obj,rows}=method();assert.equal(obj.pPut(data(fixture)).kod,200);state.storage.sql.exec('INSERT INTO meta(k,v) VALUES (?,?)','kund:'+id,'Fixed customer');const before=rows(),meta=state.storage.sql.exec('SELECT * FROM meta').toArray();
 const r=obj.pPut({...data(old()),rev:1});assert.equal(r.kod,426);assert.equal(r.status,'projektversion_stods_inte');assert.deepEqual(rows(),before);assert.deepEqual(state.storage.sql.exec('SELECT * FROM meta').toArray(),meta);
});
test('unknown or malformed stored versions do not fall back to V1 and never overwrite data',()=>{
 for(const raw of ['{bad',JSON.stringify({...fixture,version:3}),JSON.stringify({kund:'unknown'})]){
  const {state,obj,rows}=method();state.storage.sql.exec('INSERT INTO projekt(id,rev,namn,data,storlek,andrad_ms,raderad_ms) VALUES(?,7,?,?,?,1,NULL)',id,'preserved',raw,Buffer.byteLength(raw));const before=rows();assert.equal(obj.pPut({...data(old()),rev:7}).kod,426);assert.deepEqual(rows(),before);
 }
});
test('V1 to V2 promotion and V2 updates keep normal If-Match and tombstone semantics',()=>{
 const {obj,rows}=method();assert.equal(obj.pPut(data(old())).kod,200);assert.equal(obj.pPut({...data(fixture),rev:1}).kod,200);assert.equal(rows()[0].rev,2);
 const conflict=obj.pPut({...data(fixture),rev:1});assert.equal(conflict.kod,409);assert.deepEqual(conflict.server.data,fixture);assert.equal(rows()[0].rev,2);
 assert.equal(obj.pDel({ms:Date.now(),id,rev:2}).kod,200);assert.equal(obj.pPut({...data(fixture),rev:3}).kod,410);
});
async function http(run){
 const owner='owner.project2@example.invalid',out=[],e=ENV({PRO_PAYMENTS:'off',PRO_KONTO:'inbjudna',PRO_OWNER_EMAIL:owner,PRO_MAIL_DAY_CAP:'1000'});e.PRO_REGISTER=namnrymd(ProRegister);e.PRO_KONTON=namnrymd(ProKonto,e);const originalFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{assert.equal(String(url),'https://api.resend.com/emails');out.push(JSON.parse(init.body));return Response.json({id:'re_synthetic_'+out.length})};
 const fetch=async(path,{method='GET',cookie,body,rev}={})=>{const waits=[],headers={'CF-Connecting-IP':'198.51.100.44'};if(method!=='GET')Object.assign(headers,{Origin:'https://stahledigital.se','X-MR-Pro':'1','content-type':'application/json'});if(cookie)headers.Cookie=cookie;if(rev!==undefined)headers['If-Match']=String(rev);const r=await worker.fetch(new Request('https://granskaminoffert-api.anders-316.workers.dev'+path,{method,headers,...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})}),e,{waitUntil:p=>waits.push(p)});await Promise.all(waits);return r};
 const login=async(email=owner)=>{const n=out.length;assert.equal((await fetch('/pro/konto/kod',{method:'POST',body:{epost:email}})).status,202);assert.equal(out.length,n+1);const kod=/\n {4}(\d{6})\n/.exec(out.at(-1).text)[1];const r=await fetch('/pro/konto/logga-in',{method:'POST',body:{epost:email,kod}});assert.equal(r.status,200);return r.headers.get('set-cookie').split(';')[0]};
 try{await run({fetch,login,e,owner})}finally{globalThis.fetch=originalFetch}
}
test('actual login/HTTP/SQLite preserves full V2, blocks downgraded old clients and returns whole 409 server state',async()=>http(async({fetch,login})=>{
 const a=await login(),b=await login();let r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:a,body:fixture,rev:0});assert.equal(r.status,200);assert.equal((await r.json()).rev,1);
 const got=await(await fetch('/pro/konto/projekt/'+id,{cookie:b})).json();assert.deepEqual(got.projekt.data,fixture);
 r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:b,body:old(),rev:1});assert.equal(r.status,426);assert.equal((await r.json()).status,'projektversion_stods_inte');
 const changed=cp(fixture);changed.projektnamn='A newer';r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:a,body:changed,rev:1});assert.equal(r.status,200);
 r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:b,body:fixture,rev:1});assert.equal(r.status,409);assert.deepEqual((await r.json()).server.data,changed);
 const exported=await(await fetch('/pro/konto/export',{cookie:a})).json();assert.deepEqual(exported.projekt.find(p=>p.id===id).data,changed);
}));
test('actual HTTP validates all V2 source bytes and exact whole request UTF8 boundaries',async()=>http(async({fetch,login})=>{
 const cookie=await login(),bad=cp(fixture);bad.raknarlista.parts.at(-1).rows[0].v++;assert.equal((await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie,body:bad,rev:0})).status,400);
 for(const delta of [-1,0,1]){const p=cp(fixture);p.extra='';const available=262144+delta-Buffer.byteLength(JSON.stringify(p));p.extra='漢'.repeat(Math.floor(available/3))+'a'.repeat(available%3);const text=JSON.stringify(p);assert.equal(Buffer.byteLength(text),262144+delta);const r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie,body:text,rev:delta<0?0:1});assert.equal(r.status,delta>0?413:200)}
}));
test('actual sessions keep the same project ID isolated between two accounts',async()=>http(async({fetch,login,e})=>{
 const other='second.project2@example.invalid';await register(e,'testbevis',{nu:Math.floor(Date.now()/1000),ehash:await epostHash(e,other),slut:Math.floor(Date.now()/1000)+86400});const a=await login(),b=await login(other);
 assert.equal((await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:a,body:fixture,rev:0})).status,200);assert.equal((await fetch('/pro/konto/projekt/'+id,{cookie:b})).status,404);
 const otherProject=cp(fixture);otherProject.projektnamn='Account B';assert.equal((await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie:b,body:otherProject,rev:0})).status,200);
 assert.deepEqual((await(await fetch('/pro/konto/projekt/'+id,{cookie:a})).json()).projekt.data,fixture);assert.deepEqual((await(await fetch('/pro/konto/projekt/'+id,{cookie:b})).json()).projekt.data,otherProject);
}));

// R104: current client schema owns the optional saved PDF preference; V2 HTTP must agree.
test('R104 actual V2 HTTP rejects nonboolean saved working appendix preferences without storing them',async()=>http(async({fetch,login})=>{
 const cookie=await login();
 for(const value of [null,0,1,'true','false',[],{}]){const p=cp(fixture);p.val={...p.val,intern_arbetsplan:value};const r=await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie,body:p,rev:0});assert.equal(r.status,400,'invalid preference '+JSON.stringify(value));assert.equal((await fetch('/pro/konto/projekt/'+id,{cookie})).status,404);}
 for(const [i,value]of[false,true].entries()){const p=cp(fixture);p.val={...p.val,intern_arbetsplan:value};assert.equal((await fetch('/pro/konto/projekt/'+id,{method:'PUT',cookie,body:p,rev:i})).status,200);assert.equal((await(await fetch('/pro/konto/projekt/'+id,{cookie})).json()).projekt.data.val.intern_arbetsplan,value);}
}));
