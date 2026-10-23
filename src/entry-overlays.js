// Runs inside the page. Only consent/age controls, never generic game confirmations.
export function dismissEntryOverlays(){
  const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';};
  const label=el=>(el.innerText||el.textContent||el.value||el.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim().replace(/[!.]+$/,'');
  const controls=()=>[...document.querySelectorAll('button,a,[role="button"],input[type="button"],input[type="submit"],[onclick],span,div,p,li,label')].filter(el=>(!el.matches('span,div,p,li,label')||el.matches('[role="button"],[onclick]')||!el.children.length)&&visible(el));
  const context=(el,kind)=>{
    for(let node=el.parentElement,depth=0;node&&node!==document.body&&depth<8;node=node.parentElement,depth++){
      const identity=[node.id,node.className,node.getAttribute('aria-label')].filter(v=>typeof v==='string').join(' ');
      const text=(node.innerText||node.textContent||'').replace(/\s+/g,' ').slice(0,5000);
      if(kind==='cookies'&&(/cookie|consent|onetrust|cybot|didomi|cmpbox|privacy[-_ ]?(?:banner|notice)/i.test(identity)||text.length<1600&&/we use cookies|cookies [&and ]+privacy|tracking preferences/i.test(text)||node.matches('dialog,[role="dialog"],[aria-modal="true"]')&&/cookies|tracking preferences/i.test(text))&&!/terms of service|terms and conditions|términos y condiciones|EULA/i.test(text))return true;
      if(kind==='age'&&(/age[-_ ]?(?:gate|verif|confirm|check)|verify[-_ ]?age|adult|(?:^|[\s_-])age(?:[\s_-]|$)/i.test(identity)||node.matches('dialog,[role="dialog"],[aria-modal="true"]')||text.length<1600&&/age verification|must be at least (?:18|21) years|legal (?:gambling )?age|verify.{0,40}(?:18|21|age)|confirm.{0,40}age requirement/i.test(text))&&
        (/\b(?:18|21)\b/.test(text)||/legal (?:gambling )?age/i.test(text))&&/age|years|older|legal|edad|años|adult|idade|âge|alter/i.test(text)&&!/purchase|buy bonus|total bet|balance|comprar|apuesta|saldo/i.test(text)&&!node.querySelector('input[type="date"],input[name*="birth"],input[name*="dob"]'))return true;
    }
    return false;
  };
  const reject=/^(?:reject(?: all(?: cookies)?)?|decline(?: all)?|deny(?: all)?|only necessary(?: cookies)?|necessary(?: cookies)? only|rechazar(?: todo| todas)?|solo necesarias|refuser(?: tout)?|tout refuser|nur notwendige|ablehnen)$/i;
  const accept=/^(?:accept(?: all(?: cookies)?| cookies)?|i accept|allow all|i agree|agree|got it|ok(?:ay)?|aceptar(?: todas| cookies)?|aceito|akzeptieren|alles akzeptieren|j'accepte|tout accepter)$/i;
  const knownReject=/onetrust-reject-all-handler|CybotCookiebotDialogBodyButtonDecline|didomi-notice-disagree-button|cky-btn-reject|cc-deny/i;
  const knownAccept=/onetrust-accept-btn-handler|CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll|didomi-notice-agree-button|cookie_action_close_header|cky-btn-accept|cc-allow/i;
  const result={cookies:0,age:0};
  const cookieButtons=controls().map(el=>({el,text:label(el),identity:el.id+' '+el.className}));
  const cookie=cookieButtons.find(b=>knownReject.test(b.identity)||b.el.getAttribute('data-cookie-action')==='reject'||context(b.el,'cookies')&&reject.test(b.text))||
    cookieButtons.find(b=>knownAccept.test(b.identity)||context(b.el,'cookies')&&accept.test(b.text));
  if(cookie){cookie.el.click();result.cookies++;}
  const explicitAge=/^(?:yes,?\s*)?(?:i am|i['’]m) (?:of legal (?:gambling )?age|over (?:18|21)|(?:18|21)(?: years)?(?: old)? (?:or older|and over))\.?$|^(?:sí|si),? tengo (?:18|21) años o más\.?$|^(?:sim),? tenho (?:mais de )?(?:18|21) anos(?: ou mais)?\.?$/i;
  const age=controls().find(el=>{
    const text=label(el);
    return el.getAttribute('data-age-gate-confirm')==='true'||explicitAge.test(text)||
      context(el,'age')&&/^(?:yes(?:,? i am(?: (?:18|21)\+)?)?|sí|si|sim|oui|ja|confirm|confirmar|enter(?: \(if (?:18|21) or older\))?|entrar|i am (?:over |at least )?(?:18|21)(?:\+| years or older)?|i['’]m (?:over )?(?:18|21)(?:\+| or older)?)$/i.test(text);
  });
  if(age){age.click();result.age++;}
  return result;
}

export function preferenceState(state){
  const keep=row=>{
    const key=String(row.name||'').replace(/[-_.:]/g,'');
    if(/^(?:age(?:gate)?(?:verified|confirmed|accepted|verification|confirmation)|(?:is)?(?:adult|over18|over21)(?:confirmed|verified)?|verifiedage)$/i.test(key))return String(row.value||'').length<=40;
    return /^(?:cookie(?:consent|preferences?|policy|notice|banner|accepted|yes)|consent(?:status|preferences?|given|accepted|dismissed|uuid|id|data|time|token)?$|optanon|didomi|euconsent|cky)/i.test(key)&&String(row.value||'').length<=8192;
  };
  return {cookies:(Array.isArray(state?.cookies)?state.cookies:[]).filter(keep),origins:(Array.isArray(state?.origins)?state.origins:[]).map(origin=>({origin:origin.origin,localStorage:(Array.isArray(origin.localStorage)?origin.localStorage:[]).filter(keep)})).filter(origin=>origin.localStorage.length)};
}
