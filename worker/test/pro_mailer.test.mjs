import test from 'node:test';import assert from 'node:assert/strict';
import {mailHttpConfig,sendViaHttp} from '../src/pro_mailer.js';
const old='re_existing_company_credential_fixture',fresh='re_product_domain_only_credential_fixture';
const env=()=>({COMPARE_MAIL_HTTP:'1',COMPARE_MAIL_HTTP_VERIFIED:'1',COMPARE_MAIL_FROM:'Ståhle Digital <hej@stahledigital.se>',COMPARE_MAIL_DAY_CAP:'100',COMPARE_MAIL_API_KEY:old,COMPARE_MAIL_WEBHOOK_SECRET:'whsec_'+btoa('synthetic-webhook-secret-32-bytes'),PRO_MAIL_API_KEY:fresh});
test('PRO transport selects its restricted key without changing the company adapter or environment',async()=>{
 const e=env(),originalFetch=globalThis.fetch,auth=[];
 globalThis.fetch=async(url,init)=>{assert.equal(url,'https://api.resend.com/emails');auth.push(init.headers.authorization);return Response.json({id:'synthetic_msg_123456'})};
 try {
  assert.equal(mailHttpConfig(e).on,true);
  await sendViaHttp(e,{req:{from:'Materialräknaren <support@materialraknaren.se>',to:['synthetic@example.test'],text:'synthetic'},idemKey:'synthetic'});
  assert.equal(auth[0],'Bearer '+fresh);assert.equal(e.COMPARE_MAIL_API_KEY,old);
  const {sendViaHttp:companySend}=await import('../src/compare_mailer.js');await companySend(e,{req:{},idemKey:'company-fixture'});
  assert.equal(auth[1],'Bearer '+old);
 } finally{globalThis.fetch=originalFetch}
});
test('present invalid product credential fails closed, absent preserves existing legacy configuration',()=>{
 assert.equal(mailHttpConfig({...env(),PRO_MAIL_API_KEY:'invalid'}).on,false);
 const e=env();delete e.PRO_MAIL_API_KEY;assert.equal(mailHttpConfig(e).on,true);
});
