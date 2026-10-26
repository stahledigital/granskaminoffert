// PRO may use a product-domain-only sending key. Company/compare mail is untouched.
import {mailHttpConfig as baseConfig,sendViaHttp as baseSend} from './compare_mailer.js';
export {buildMailRequest,validMailTo} from './compare_mailer.js';
function transportEnv(env) {
  return env && Object.prototype.hasOwnProperty.call(env,'PRO_MAIL_API_KEY')
    ? {...env,COMPARE_MAIL_API_KEY:env.PRO_MAIL_API_KEY} : env;
}
export const mailHttpConfig=env=>baseConfig(transportEnv(env));
export function sendViaHttp(env,data) {
  const isolated=transportEnv(env);
  if(!baseConfig(isolated).on)return Promise.resolve({ok:false,kind:'config',code:'pro_mejl_konfiguration'});
  return baseSend(isolated,data);
}
