// Public provider catalog/demo authorities, shared with the Tester Spin catalog.
export const PROVIDERS={
  pragmatic:['Pragmatic Play','www.pragmaticplay.fun','pragmaticplay.fun','www.pragmaticplay.com'],
  '1spin4win':['1Spin4Win','www.1spin4win.com','gs.1spin4win.com'],
  '3oaks':['3 Oaks','3oaks.com','www.3oaks.com'],
  belatra:['Belatra','belatragames.com','free-slot.belatragames.com','demo.bltr-static.com'],
  bgaming:['BGaming','bgaming.com','bgaming-network.com','demo.bgaming-network.com'],
  hacksaw:['Hacksaw Gaming','www.hacksawgaming.com'],
  ka_gaming:['KA Gaming','www.kagaming.com','www.kaga88.com','gamesdemo.kaga88.com'],
  nolimit_city:['Nolimit City','www.nolimitcity.com','nolimitcity.com','playin.com','demo.nolimitcity.com'],
  redtiger:['Red Tiger','games.evolution.com'],
  rubyplay:['RubyPlay','rubyplay.com'],
  yggdrasil:['Yggdrasil','yggdrasilgaming.com','demo.yggdrasilgaming.com'],
  playtech:['Playtech','www.playtechone.com','cachedownload.playtechone.com'],
  games_global:['Games Global','www.gamesglobal.com'],
  amusnet:['Amusnet','amusnet.com','www.amusnet.com','amusnetgaming.com'],
  playngo:['Play’n GO','www.playngo.com'],
  greentube:['Greentube','www.greentube.com'],
  netent:['NetEnt','netent.com','www.netent.com'],
  pgsoft:['PG Soft','www.pgsoft.com'],
  blueprint:['Blueprint','blueprintgaming.com'],
  relax:['Relax Gaming','www.relax-gaming.com'],
  playson:['Playson','www.playson.com','playson.com','m.playson.com'],
  wazdan:['Wazdan','wazdan.com'],
  elk:['ELK Studios','www.elk-studios.com'],
  pushgaming:['Push Gaming','www.pushgaming.com'],
  thunderkick:['Thunderkick','www.thunderkick.com'],
  quickspin:['Quickspin','quickspin.com','www.quickspin.com'],
};
export function providerFor(raw){
  try{const host=new URL(raw).hostname.toLowerCase();return Object.keys(PROVIDERS).find(key=>PROVIDERS[key].slice(1).includes(host))||null;}catch{return null;}
}
export function publicDemoUrl(raw){
  if(typeof raw!=='string'||raw.length>2000)throw Error('Invalid game URL');
  const u=new URL(raw.trim()),provider=providerFor(u.href);
  if(!provider||u.protocol!=='https:'||u.username||u.password||u.port&&!(provider==='1spin4win'&&u.port==='10443'))throw Error('Only official public provider catalog and DEMO URLs are allowed');
  for(const [key,value] of u.searchParams)if(/^(real|realmoney|mode)$/i.test(key)&&!/^(0|false|demo|fun)$/i.test(value))throw Error('Only DEMO mode is allowed');
  if(provider==='bgaming'&&u.hostname.includes('bgaming-network.com')&&(!/\/FUN\/?$/.test(u.pathname)||(u.searchParams.get('server')|| (u.hostname==='demo.bgaming-network.com'?'demo':''))!=='demo'))throw Error('Only BGaming FUN demo sessions are allowed');
  if(u.hostname==='gs.1spin4win.com'&&u.searchParams.get('freeplay')!=='true')throw Error('Only 1Spin4Win freeplay sessions are allowed');
  if(u.hostname==='gamesdemo.kaga88.com'&&u.searchParams.get('p')!=='demo')throw Error('Only KA demo sessions are allowed');
  if(u.hostname==='cachedownload.playtechone.com'&&u.searchParams.get('real')!=='0')throw Error('Only Playtech offline demos are allowed');
  if(u.hostname==='playin.com'&&!u.pathname.startsWith('/embed/v1/demo/'))throw Error('Only Nolimit demo embeds are allowed');
  if(provider==='pragmatic'&&(u.search||u.hash||!(u.hostname==='www.pragmaticplay.com'?/^\/[a-z]{2}\/games\/[a-z0-9-]+\/?$/i:/^\/[a-z]{2}\/slots\/[a-z0-9-]+\/?$/i).test(u.pathname)))throw Error('Only public Pragmatic DEMO catalog URLs are allowed');
  if(provider==='pragmatic'&&!u.pathname.endsWith('/'))u.pathname+='/';
  if(provider==='amusnet'&&u.hostname==='amusnetgaming.com'&&/^\/[a-z0-9]+(?:-[a-z0-9]+)+\/?$/.test(u.pathname)&&!/^\/(?:online-casino|live-casino|about-us|contact-us|privacy-policy|cookie-policy)\/?$/.test(u.pathname))u.pathname='/games/online-casino/'+u.pathname.replace(/^\/|\/$/g,'');
  return u.href;
}
