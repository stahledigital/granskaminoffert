// Public product links: clean paths on the new site; retain the old namespace
// for deployments which have not adopted the new PRO_SITE_URL yet.
const OLD='https://stahledigital.se', NEW='https://materialraknaren.se';
const PATHS=new Set(['/offert','/villkor','/angra','/konto/agare']);
export function proSite(env) {
  const value=String(env?.PRO_SITE_URL||OLD).replace(/\/$/,'');
  return /^https:\/\/[^\s"'<>]+$/.test(value)?value:OLD;
}
export function proPublicUrl(env,path) {
  if(!PATHS.has(path))throw Error('Invalid product path');
  const site=proSite(env);
  return site+(site===NEW?'':'/verkstaden/materialraknaren')+path;
}
