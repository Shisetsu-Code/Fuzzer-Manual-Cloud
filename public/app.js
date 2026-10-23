const $=id=>document.getElementById(id);
const DEFAULT_KEYS={next:'Space',previous:'Shift+Space',undo:'KeyZ',skip:'KeyS',pause:'KeyP',finish:'KeyF'};
const KEY_LABELS={next:'Guardar y siguiente',previous:'Ver anterior',undo:'Deshacer',skip:'Cerrar rama',pause:'Pausar preparación',finish:'Finalizar juego'};
const store={providerFilter:'',items:[],selectedId:null,marks:[],features:{},progress:null,history:[],review:null,optimistic:new Set(),imageKeep:new Map(),hotkeys:{...DEFAULT_KEYS},running:false,remoteOnline:false,pollBusy:false};
let toastTimer;
function toast(text,isError=false){const node=$('toast');node.textContent=text;node.className=isError?'error':'';node.style.display='block';clearTimeout(toastTimer);toastTimer=setTimeout(()=>node.style.display='none',3000);}
function problemText(error){
  const text=String(error);
  if(text.startsWith('LIVE_SESSION_LOST'))return 'La sesión anterior se cerró. Hay una captura nueva para empezar de nuevo.';
  if(text.startsWith('BRANCH_REBUILD_FAILED'))return 'No se pudo reconstruir este menú en otra sesión. La rama original conserva su propio recorrido.';
  if(text.startsWith('STATE_MISMATCH'))return 'El juego no llegó al estado esperado después de esperar la transición.';
  if(text.startsWith('CONTROL_MISSING'))return 'El control esperado no apareció; la rama se detuvo.';
  if(text.startsWith('GAME_NOT_READY'))return 'El juego no llegó a una pantalla interactiva dentro del tiempo de espera.';
  return text.slice(0,100);
}
async function api(url,method='GET',body){const res=await fetch(url,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let data;
  try{data=await res.json();}catch{data={error:`HTTP ${res.status}`};}
  if(!res.ok)throw Error(data.error||`HTTP ${res.status}`);return data;
}
function getCurrent(){return store.review||store.items.find(x=>x.id===store.selectedId)||null;}
function canFinishGame(game,item){
  if(!game||game.finishedAt||!Number.isFinite(game.pendingPaths))return false;
  return game.pendingPaths===0||(game.pendingPaths===1&&game.readyPaths===1&&(item?.game_id!=null?item.game_id===game.id:item?.slug===game.slug));
}
function antebetNotice(capture){
  const phase=capture?.antebet?.phase;
  if(!phase||phase==='done')return '';
  if(phase==='close')return 'Antebet activado: no pude salir del menú. No hice la tirada.';
  if(phase==='spin')return 'Antebet activado: no encontré el botón de tirada. No hice la tirada.';
  if(phase==='wait-spin')return 'Antebet: la tirada se inició, pero no pude confirmar que terminó. Revisá la captura.';
  return 'Antebet pendiente: no pude confirmar que se activó. No hice la tirada.';
}
function selectFirst(){if(store.selectedId&&!store.items.some(x=>x.id===store.selectedId))store.selectedId=null;
  if(!store.selectedId&&store.items.length)store.selectedId=store.items[0].id;
}
function imageUrl(item){return `/api/images/${item.id}?v=${encodeURIComponent(item.capture?.capturedAt||item.updated_at||'')}`;}
function preload(items){for(const item of items.slice(0,40)){
  if(store.imageKeep.has(item.id))continue;
  const image=new Image();image.decoding='async';image.src=imageUrl(item);store.imageKeep.set(item.id,image);
  if(store.imageKeep.size>65){const oldest=store.imageKeep.keys().next().value;store.imageKeep.delete(oldest);}
}}
function display(){
  const item=getCurrent();const review=Boolean(store.review);
  $('image-wrap').hidden=!item;$('empty').hidden=!!item;
  $('save-btn').disabled=!item||review;$('skip-btn').disabled=!item||review;
  const game=store.progress?.find(g=>g.id===item?.game_id);
  $('finish-btn').disabled=!item||review||!store.features.finishGame||store.marks.length>0||!canFinishGame(game,item);
  $('finish-btn').title=game?.pendingPaths>1?`Quedan ${game.pendingPaths-1} caminos más por resolver`:'Finaliza el juego cuando todos sus caminos están resueltos';
  $('undo-btn').disabled=!store.marks.length||review;
  $('previous-btn').disabled=!store.history.length;
  if(!item){$('game-title').textContent='Sin fotografía seleccionada';$('game-subtitle').textContent='El navegador prepara imágenes mientras catalogás otras';$('photo-status').textContent='COLA VACÍA';$('shot').removeAttribute('src');}
  else{
    $('game-title').textContent=item.name||item.slug.replaceAll('-',' ').replace(/\b\w/g,x=>x.toUpperCase());
    $('game-subtitle').textContent=`Captura #${item.id}`;
    $('photo-status').textContent=review?'REVISIÓN':item.capture?.entryReview?'Acceso pendiente':item.capture?.manualReview?(item.capture?.gameRunning?'Juego iniciado':item.capture?.gameRunning===false?'Inicio pendiente':'Revisión manual'):({BASE:'Base',BUY_MENU:'Compras',CONFIRM:'Confirmación',BONUS:'Bonus'}[item.capture?.state]||'Captura');
    const url=imageUrl(item);if($('shot').getAttribute('src')!==url)$('shot').src=url;
  }
  $('viewport').classList.toggle('readonly',review);$('hint').textContent=review?'Captura anterior · Espacio para volver':'Clic: marcar · Derecho: antebet · Espacio: guardar';
  const antebetWarning=antebetNotice(item?.capture);
  $('live-note').hidden=!antebetWarning&&!item?.capture?.manualReview;
  $('live-note').textContent=antebetWarning||item?.capture?.manualReason||(item?.capture?.entryReview?'Acceso a demo pendiente. Marcá dónde abrir el juego o cerrá la rama.':item?.capture?.manualReview?(item.capture?.gameRunning?'Juego iniciado. Marcá las opciones que quieras analizar.':'No pude confirmar el inicio. Marcá dónde continuar o cerrá la rama.'):'');
  const phase=item?.capture?.flowCompletion?.phase;
  if(phase)$('cloud-phase').textContent=({confirmation:'Confirmación pendiente',start:'Inicio de bonus pendiente',choice:'Elegí una opción del bonus',active:'Bonus en curso',result:'Premio: falta continuar',completed:'Compra completada y premio confirmado',idle:'Pantalla base',unknown:'Revisión manual'})[phase]||phase;
  renderPins();renderQueue();renderProgress();
}
function renderProgress(force=false){
  const item=getCurrent(),game=store.progress?.find(g=>g.id===item?.game_id);
  $('review-game-btn').disabled=!game;
  $('review-game-btn').textContent=game?.reviewRequestedAt?'★ Para revisar':'☆ Revisar';
  $('review-game-btn').setAttribute?.('aria-pressed',String(!!game?.reviewRequestedAt));
  $('current-progress').textContent=game?`Compras realizadas: ${game.purchases.completed}\nAntebets realizados: ${game.antebets.completed}\nCaminos pendientes: ${game.pendingPaths??0}`:'Seleccioná un juego';
  if(!force&&!$('progress-dialog').open)return;
  const rows=$('progress-rows');rows.replaceChildren();
  const visible=historyGames();
  for(const g of visible){
    const row=document.createElement('tr');
    for(const text of [(g.name||g.slug)+(g.provider?' · '+g.provider:''),String(g.purchases.completed),String(g.antebets.completed),String(g.pendingPaths??0)]){const cell=document.createElement('td');cell.textContent=text;row.append(cell);}
    if(g.url){const link=document.createElement('a');link.href=g.url;link.target='_blank';link.rel='noopener noreferrer';link.textContent=` · #${g.id} ↗`;row.children[0].append(link);}
    const state=document.createElement('td');
    if(g.finishedAt)state.textContent='Finalizado';
    else{const button=document.createElement('button');button.type='button';button.textContent='Finalizar';button.disabled=!store.features.finishGame||!canFinishGame(g,item);button.title=button.disabled?'Hay caminos pendientes':'Finalizar juego';button.addEventListener('click',()=>finalizeGame(g,item));state.append(button);}
    row.append(state);
    const review=document.createElement('td'),flag=document.createElement('button');flag.type='button';flag.textContent=g.reviewRequestedAt?'★ Para revisar':'☆ Revisar';flag.addEventListener('click',()=>toggleGameReview(g));review.append(flag);row.append(review);
    rows.append(row);
  }
  $('progress-summary').textContent=store.progress===null?'El registro se activará con el próximo reinicio del servidor.'
    :`${visible.length} juegos · ${visible.reduce((n,g)=>n+g.purchases.completed,0)} compras realizadas · ${visible.reduce((n,g)=>n+g.antebets.completed,0)} antebets con tirada completada`;
}
function historyGames(){return (store.progress||[]).filter(g=>(!$('history-provider').value||g.provider===$('history-provider').value)&&(!$('history-review').checked||g.reviewRequestedAt));}
async function toggleGameReview(game){
  if(!game||store.reviewBusy)return;
  store.reviewBusy=true;
  try{const result=await api(`/api/games/${game.id}/review`,'POST',{review:!game.reviewRequestedAt});game.reviewRequestedAt=result.reviewRequestedAt;renderProgress(true);toast(result.reviewRequestedAt?'Juego marcado para revisar':'Marca de revisión quitada');}
  catch(e){toast(e.message,true);}finally{store.reviewBusy=false;}
}
function downloadHistory(format){
  const params=new URLSearchParams({format});if($('history-provider').value)params.set('provider',$('history-provider').value);if($('history-review').checked)params.set('review','1');
  const link=document.createElement('a');link.href='/api/history/export?'+params;link.download=`historial-${$('history-provider').value||'todos'}.${format}`;document.body.append(link);link.click();link.remove();
}
function renderPins(){
  const pins=$('pins');pins.replaceChildren();const marks=store.review?.savedMarks||store.marks;
  marks.forEach((m,i)=>{const el=document.createElement('div');el.className='pin'+(m.kind==='antebet'?' antebet':'');el.style.left=`${m.x*100}%`;el.style.top=`${m.y*100}%`;el.textContent=(m.kind==='antebet'?'A':'')+String(i+1);el.title=m.label||`Clic ${i+1}`;pins.append(el);});
  $('marks-count').textContent=`${marks.length} ${marks.length===1?'marca':'marcas'}`;
  const list=$('mark-list');list.replaceChildren();
  const item=getCurrent(),game=store.progress?.find(g=>g.id===item?.game_id);
  $('finish-btn').disabled=!item||!!store.review||!store.features.finishGame||store.marks.length>0||!canFinishGame(game,item);
  if(!marks.length){const n=document.createElement('div');n.className='muted small';n.textContent='Todavía no hay marcas.';list.append(n);return;}
  marks.forEach((m,i)=>{const row=document.createElement('div');row.className='mark-row';
    const a=document.createElement('div');const badge=document.createElement('span');badge.className='ordinal';badge.textContent=String(i+1);a.append(badge,document.createTextNode(m.kind==='antebet'?'Antebet':'Clic'));
    row.append(a);
    if(!store.review){
      const note=document.createElement('input');note.className='mark-note';note.placeholder='Nota opcional';note.maxLength=80;note.value=m.label||'';note.addEventListener('input',()=>{m.label=note.value;});a.append(note);
      const b=document.createElement('button');b.textContent='✕';b.title='Quitar esta marca';b.addEventListener('click',()=>{store.marks.splice(i,1);renderPins();});row.append(b);
    }
    list.append(row);
  });
}
function renderQueue(){
  const list=$('queue-list');list.replaceChildren();$('queue-counter').textContent=`${store.items.length} capturas listas`;
  for(const item of store.items.slice(0,250)){
    const el=document.createElement('div');el.className='queue-item'+(!store.review&&item.id===store.selectedId?' active':'');
    const name=document.createElement('div');name.className='name';name.textContent=item.name||item.slug;
    const line=document.createElement('div');line.className='detail';
    const first=document.createElement('span');first.textContent=`${item.provider||'pragmatic'} · #${item.id}`;
    const last=document.createElement('span');last.textContent=item.capture?.entryReview?'Acceso pendiente':item.capture?.manualReview?(item.capture?.gameRunning?'Iniciado':item.capture?.gameRunning===false?'Inicio pendiente':'Manual'):item.capture?.state==='BONUS'?'Bonus':item.live?'En sesión':'Lista';
    line.append(first,last);el.append(name,line);
    if(antebetNotice(item.capture)){const warning=document.createElement('small');warning.className='antebet-alert';warning.textContent='⚠ Antebet pendiente';el.append(warning);}
    el.addEventListener('click',()=>{if(store.marks.length){if(!confirm('¿Descartar marcas todavía no guardadas?'))return;store.marks=[];}store.review=null;store.selectedId=item.id;display();});list.append(el);
  }
}
function renderStatus(status){
  const lanes=status.providerWorkers||[];
  if(status.cloud){store.remoteOnline=status.cloud.workers.length>0;$('pause-btn').disabled=!!status.cloud.launching;$('cloud-client-id').textContent=status.cloud.clientId;lanes.splice(0,lanes.length,...status.cloud.workers.map(w=>({provider:w.id,state:'working',captures:w.live.length})));}
  $('workers-summary').textContent=status.cloud?`${status.cloud.workers.length} workers remotos · ${status.live} sesiones vivas`:`${status.activeRoots||0} proveedores cargando`;
  const workerList=$('workers-list');workerList.replaceChildren();
  const labels={working:'Cargando',paused:'Pausado',limit:'Límite alcanzado',empty:'Sin juegos pendientes',cooldown:'Espera',waiting:'Esperando disponibilidad'};
  for(const lane of lanes){const row=document.createElement('div');row.textContent=`${lane.provider}: ${labels[lane.state]||lane.state}${lane.state==='cooldown'?` ${lane.waitSeconds}s`:''} · ${lane.captures}/100`;workerList.append(row);}
  $('stat-ready').textContent=status.limits?`${status.buffer?.readyGames??0}`:`${status.buffer?.readyGames??status.db.tasks.ready??0}/${status.buffer?.target||20}`;
  $('buffer-note').textContent=status.cloud?.error?status.cloud.error:status.active?`Preparando ${status.active}…`:status.paused?'Preparación pausada':status.limits?'Capturas descargadas en esta PC':'Reserva lista';
  $('buffer-state').textContent=status.paused?'Preparación pausada':'Preparación automática en segundo plano';
  store.running=!status.paused;$('pause-btn').textContent=status.cloud?.launching?'Arrancando en GitHub…':(status.paused||!store.remoteOnline)?'▶ Iniciar workers':'Ⅱ Pausar workers';
}
async function refresh(){if(store.pollBusy)return;store.pollBusy=true;
  try{
    const [queue,status]=await Promise.all([api('/api/queue?limit=250'+(store.providerFilter?'&provider='+encodeURIComponent(store.providerFilter):'')),api('/api/status')]);
    // Older running servers keep their sessions until the user chooses to restart.
    if(Date.now()-(store.progressAt||0)>5000){
      const progress=await api('/api/progress').catch(()=>null);store.progress=progress?.games||null;store.progressAt=Date.now();
    }
    store.items=queue.items.filter(t=>!store.optimistic.has(t.id));selectFirst();preload(store.items);
    renderStatus(status);
    const problems=$('problems');problems.replaceChildren();
    $('issue-count').textContent=queue.problems.length;
    if(!queue.problems.length)problems.textContent='Sin incidencias';
    for(const p of queue.problems){
      const div=document.createElement('div');div.className='problem';div.textContent=`${p.slug}: ${problemText(p.error)}`;div.title=String(p.error);problems.append(div);
      const close=document.createElement('button');close.type='button';close.textContent='Descartar ruta';close.addEventListener('click',async()=>{try{await api(`/api/tasks/${p.id}/finish`,'POST',{});store.progressAt=0;await refresh();}catch(e){toast(e.message,true);}});div.append(close);
    }
    if(!store.review)display();
  }catch(e){console.warn(e);}
  finally{store.pollBusy=false;}
}
$('image-wrap').addEventListener('pointermove',e=>{
  const bounds=$('shot').getBoundingClientRect();const x=(e.clientX-bounds.left)/bounds.width,y=(e.clientY-bounds.top)/bounds.height;
  if(x>=0&&x<=1&&y>=0&&y<=1)$('cursor').textContent=`x: ${x.toFixed(4)} / y: ${y.toFixed(4)}`;
});
function addMark(e,kind){
  if(store.review||!getCurrent())return;
  if(kind==='click'&&!store.features.freeClicks)return toast('Los clics libres se activarán al reiniciar el servidor actualizado.',true);
  if(kind==='antebet'&&!store.features.antebet)return toast('Antebet estará disponible al reiniciar el servidor actualizado. Tus sesiones siguen abiertas.',true);
  const r=$('shot').getBoundingClientRect();const x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height;
  if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||x>1||y<0||y>1)return;
  if(store.marks.length>=40)return toast('Máximo 40 marcas por foto',true);
  store.marks.push({x:Math.round(x*1000000)/1000000,y:Math.round(y*1000000)/1000000,kind,label:''});renderPins();
}
$('image-wrap').addEventListener('click',e=>{if(e.button===0)addMark(e,'click');});
$('image-wrap').addEventListener('contextmenu',e=>{e.preventDefault();addMark(e,'antebet');});
function undo(){if(store.review)return;store.marks.pop();renderPins();}
async function commit(skip=false){
  if(store.review){store.review=null;display();return;}
  const item=getCurrent();if(!item)return;
  const marks=skip?[]:[...store.marks];
  store.optimistic.add(item.id);
  const historyItem={...item,savedMarks:marks};store.history.push(historyItem);if(store.history.length>100)store.history.shift();
  store.items=store.items.filter(t=>t.id!==item.id);store.selectedId=null;store.marks=[];selectFirst();display();
  try{const result=await api(`/api/tasks/${item.id}/commit`,'POST',{marks});historyItem.savedMarks=marks.map((m,i)=>({...m,kind:result.children[i]?.kind||m.kind}));store.optimistic.delete(item.id);store.progressAt=0;refresh();}
  catch(e){store.optimistic.delete(item.id);toast(`No se guardó #${item.id}: ${e.message}`,true);refresh();}
}
async function pause(){try{const r=await api('/api/run','POST',{running:!store.running||!store.remoteOnline,fleet:{workers:Number($('cloud-workers').value),gamesPerWorker:Number($('cloud-games').value),minutes:Number($('cloud-minutes').value)}});store.running=!r.paused;refresh();}
  catch(e){toast(e.message,true);}}
async function finalizeGame(game,item=null){
  if(!store.features.finishGame||!canFinishGame(game,item))return;
  const closingCurrent=(item?.game_id!=null?item.game_id===game.id:item?.slug===game.slug)&&game.pendingPaths===1;
  if(closingCurrent&&store.marks.length)return toast('Guardá o quitá los clics antes de finalizar',true);
  try{
    await api(`/api/games/${game.id}/finish`,'POST',closingCurrent?{taskId:item.id}:{});
    if(closingCurrent){store.history.push({...item,savedMarks:[],closed:true});store.items=store.items.filter(t=>t.id!==item.id);store.selectedId=null;store.marks=[];selectFirst();}
    store.progressAt=0;await refresh();renderProgress(true);toast('Juego finalizado');
  }catch(e){toast(e.message,true);}
}
async function finishAnalysis(){const item=getCurrent();if(!item||store.review)return;const game=store.progress?.find(g=>g.id===item.game_id);await finalizeGame(game,item);}
function previous(){if(store.history.length){store.review=store.history.at(-1);store.marks=[];display();}}
$('save-btn').addEventListener('click',()=>commit(false));$('skip-btn').addEventListener('click',()=>commit(true));
$('finish-btn').addEventListener('click',finishAnalysis);
$('undo-btn').addEventListener('click',undo);$('clear-btn').addEventListener('click',()=>{store.marks=[];renderPins();});
$('previous-btn').addEventListener('click',previous);$('pause-btn').addEventListener('click',pause);
$('refresh-btn').addEventListener('click',refresh);
$('import-open').addEventListener('click',()=>$('import-dialog').showModal());
$('settings-open').addEventListener('click',()=>$('settings-dialog').showModal());
$('progress-open').addEventListener('click',()=>{renderProgress(true);$('progress-dialog').showModal();});
$('review-game-btn').addEventListener('click',()=>toggleGameReview(store.progress?.find(g=>g.id===getCurrent()?.game_id)));
$('history-provider').addEventListener('change',()=>renderProgress(true));
$('history-review').addEventListener('change',()=>renderProgress(true));
$('export-csv').addEventListener('click',()=>downloadHistory('csv'));
$('export-json').addEventListener('click',()=>downloadHistory('json'));
$('import-submit').addEventListener('click',async()=>{
  const urls=$('import-text').value;if(!urls.trim())return;
  const button=$('import-submit');button.disabled=true;
  try{const result=await api('/api/import','POST',{urls});
    const lines=[`${result.added} agregados · ${result.existing} existentes priorizados · ${result.duplicates} repetidos · ${result.rejected.length} rechazados`];
    for(const [provider,count] of Object.entries(result.providers))lines.push(`${provider}: ${count.added} nuevos · ${count.existing} existentes`);
    for(const rejected of result.rejected.slice(0,50))lines.push(`Línea ${rejected.line}: ${rejected.error}`);
    if(result.rejected.length>50)lines.push(`Y ${result.rejected.length-50} líneas rechazadas más.`);
    $('import-result').textContent=lines.join('\n');store.progressAt=0;refresh();
  }catch(e){$('import-result').textContent=e.message;toast(e.message,true);}finally{button.disabled=false;}
});
$('import-file').addEventListener('change',async()=>{
 const file=$('import-file').files?.[0];if(!file)return;
 if(file.size>3*1024*1024){toast('La lista debe pesar menos de 3 MB.',true);return;}
 try{$('import-text').value=(await file.text()).replace(/^\uFEFF/,'');$('import-result').textContent='Lista cargada. Tocá Importar lista para procesarla.';}catch(e){toast(e.message,true);}
});
function shortcutName(e){const modifiers=[e.ctrlKey?'Ctrl':null,e.altKey?'Alt':null,e.shiftKey?'Shift':null].filter(Boolean);
  return [...modifiers,e.code].join('+');
}
document.addEventListener('keydown',e=>{
  if(e.target.closest('dialog')||['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)||e.altKey||e.metaKey||e.ctrlKey)return;
  const code=shortcutName(e),keys=store.hotkeys;
  const action=Object.keys(keys).find(key=>keys[key]===code);
  if(!action)return;
  e.preventDefault();
  if(action==='next')commit(false);else if(action==='previous')previous();else if(action==='undo')undo();else if(action==='skip')commit(true);else if(action==='pause')pause();else if(action==='finish')finishAnalysis();
});
function fillKeys(){const fields=$('key-fields');fields.replaceChildren();
  for(const [action,label] of Object.entries(KEY_LABELS)){
    const l=document.createElement('label');l.textContent=label;const input=document.createElement('input');input.dataset.action=action;input.value=store.hotkeys[action]||'';
    input.addEventListener('keydown',e=>{e.preventDefault();input.value=shortcutName(e);});fields.append(l,input);
  }
}
$('settings-dialog').addEventListener('show',fillKeys);
$('settings-open').addEventListener('click',fillKeys);
$('reset-keys').addEventListener('click',()=>{store.hotkeys={...DEFAULT_KEYS};fillKeys();});
$('save-keys').addEventListener('click',async()=>{
  const keys={};for(const input of document.querySelectorAll('#key-fields input'))keys[input.dataset.action]=input.value;
  const unique=Object.values(keys);
  if(unique.some(x=>!x)||new Set(unique).size!==unique.length)return toast('Los atajos no pueden estar vacíos ni repetidos',true);
  try{await api('/api/settings','POST',{hotkeys:keys});store.hotkeys=keys;$('settings-dialog').close();toast('Atajos guardados');}catch(e){toast(e.message,true);}
});
async function init(){loadProviders();try{const cfg=await api('/api/settings');store.features=cfg.features||{};if(cfg.hotkeys)for(const action of Object.keys(DEFAULT_KEYS)){if(cfg.hotkeys[action])store.hotkeys[action]=cfg.hotkeys[action];}}catch{}fillKeys();await refresh();setInterval(refresh,1300);}

$('provider-filter').addEventListener('change',()=>{
  if(store.marks.length){$('provider-filter').value=store.providerFilter;toast('Guarda tus clics antes de cambiar de proveedor.');return;}
  store.providerFilter=$('provider-filter').value;store.selectedId=null;store.review=null;refresh();
});
async function loadProviders(){api('/api/providers').then(({providers})=>{for(const provider of providers){for(const target of ['provider-filter','history-provider']){const option=document.createElement('option');option.value=provider.id;option.textContent=provider.name;$(target).append(option);}}}).catch(()=>{});}


$('cloud-stop').addEventListener('click',async()=>{if(!confirm('Los workers terminarán la operación actual y cerrarán las sesiones. Los bonus pendientes no se repetirán. ¿Apagar?'))return;try{await api('/api/cloud/stop','POST',{});toast('Apagado solicitado; terminando operaciones activas.');}catch(e){toast(e.message,true);}});


let captureRefreshBusy=false;
async function updateCapture(waitSeconds=0){
 const item=getCurrent();if(!item||store.review||captureRefreshBusy)return;
 if(store.marks.length)return toast('Guardá o quitá tus marcas antes de actualizar.',true);
 captureRefreshBusy=true;$('cloud-refresh').disabled=true;$('cloud-wait').disabled=true;
 const button=$('cloud-wait'),label=button.textContent;button.textContent=waitSeconds?'Esperando nueva captura…':'Actualizando captura…';
 toast(waitSeconds?`Se dará ${waitSeconds} segundos más al juego, sin hacer clic.`:'Actualizando captura, sin hacer clic.');
 try{await api(`/api/tasks/${item.id}/refresh`,'POST',{waitSeconds});store.imageKeep.delete(item.id);await refresh();}
 catch(e){toast(e.message,true);}
 finally{captureRefreshBusy=false;$('cloud-refresh').disabled=false;button.disabled=false;button.textContent=label;}
}
$('cloud-refresh').addEventListener('click',()=>updateCapture());
$('cloud-wait').addEventListener('click',()=>updateCapture(Number($('cloud-wait-seconds').value)));

init();
