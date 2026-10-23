// Runs in a page/frame. These are external entry requirements, not game states.
export function readEntryIssue(){
 const text=(document.body?.innerText||'').replace(/\s+/g,' ');
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';};
 if(/performing security verification|verify (?:that )?you are human|verify you are a human|checking your browser|just a moment/i.test(text)&&text.length<6000)return 'HUMAN_VERIFICATION';
 if(/access denied|you don.t have permission to access|not available in your (?:country|region)|blocked in your (?:country|region)/i.test(text))return 'ACCESS_DENIED';
 if(/(?:page|game) not found|404\s*(?:error|not found)/i.test(text))return 'PAGE_NOT_FOUND';
 if(/verify your age|date of birth|over the age of 18|confirm your age/i.test(text)&&[...document.querySelectorAll('input[type="date"],input[name*="birth"],input[name*="dob"]')].some(visible))return 'AGE_DETAILS_REQUIRED';
 return null;
}
export function startupNetworkIssue(provider,url){
 try{const u=new URL(url);return provider==='relax'&&u.hostname.endsWith('.api.relaxg.net')&&u.pathname.endsWith('/casino/games/getlauncherconfig')?'STARTUP_SERVICE_UNAVAILABLE':null;}catch{return null;}
}
export const ENTRY_ISSUE_TEXT={HUMAN_VERIFICATION:'El proveedor pide verificación humana.',ACCESS_DENIED:'El proveedor denegó el acceso a esta demo.',PAGE_NOT_FOUND:'El enlace del juego ya no existe en el proveedor.',AGE_DETAILS_REQUIRED:'El proveedor pide una fecha de nacimiento; requiere intervención manual.',DEMO_CONNECTION_FAILED:'El servicio de demo no pudo conectar su saldo de prueba. Requiere reintentar más tarde.',STARTUP_SERVICE_UNAVAILABLE:'El cargador de demo no pudo conectar con su servicio de inicio. Requiere reintentar más tarde.',NO_PUBLIC_DEMO:'No encontré un acceso de demo jugable en esta ficha. Hace falta un enlace de demo o revisión manual.'};
