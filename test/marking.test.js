import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function ui(fetcher){
  const nodes=new Map();
  const element=()=>({style:{},dataset:{},events:{},children:[],classList:{toggle(){}},
    getAttribute(name){return this[name]??null;},setAttribute(name,value){this[name]=value;},removeAttribute(name){delete this[name];},
    addEventListener(type,fn){this.events[type]=fn;},append(...children){this.children.push(...children);},
    replaceChildren(){this.children=[];},getBoundingClientRect(){return {left:0,top:0,width:1000,height:600};}});
  const get=id=>{if(!nodes.has(id))nodes.set(id,element());return nodes.get(id);};
  const context=vm.createContext({fetch:fetcher,document:{getElementById:get,createElement:element,createTextNode:t=>t,querySelectorAll:()=>[],addEventListener(){}},setTimeout(){},clearTimeout(){}});
  const source=fs.readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/init\(\);\s*$/,'');
  vm.runInContext(source+'\nglobalThis.state=store;',context);
  context.state.items=[{id:1}];context.state.selectedId=1;context.state.features={antebet:true,freeClicks:true,finish:true,finishGame:true};
  return {commit:context.commit,context,updateCapture:context.updateCapture,get,state:context.state,renderQueue:context.renderQueue,selectFirst:context.selectFirst,renderPins:context.renderPins,renderProgress:context.renderProgress,antebetNotice:context.antebetNotice,canFinishGame:context.canFinishGame,undo:context.undo};
}

test('left and right clicks mark several independent purchase and antebet options on one photo',()=>{
  const {get,state}=ui();let prevented=0;
  get('image-wrap').events.click({button:0,clientX:100,clientY:200});
  get('image-wrap').events.contextmenu({clientX:300,clientY:200,preventDefault(){prevented++;}});
  get('image-wrap').events.click({button:0,clientX:500,clientY:200});
  get('image-wrap').events.contextmenu({clientX:700,clientY:200,preventDefault(){prevented++;}});
  assert.deepEqual(Array.from(state.marks,m=>m.kind),['click','antebet','click','antebet']);
  assert.equal(prevented,2);assert.equal(get('pins').children[1].textContent,'A2');
});

test('review stays read-only while live screens accept a batch of marks',()=>{
  const {get,state}=ui();const click=()=>get('image-wrap').events.contextmenu({clientX:200,clientY:200,preventDefault(){}});
  state.review={id:2};click();assert.equal(state.marks.length,0);
  state.review=null;state.items[0].live=true;state.items[0].branchable=false;click();click();assert.equal(state.marks.length,2);
});

test('an older server cannot silently accept unsupported antebet marks',()=>{
  const {get,state}=ui();state.features={};
  get('image-wrap').events.contextmenu({clientX:200,clientY:200,preventDefault(){}});
  assert.equal(state.marks.length,0);assert.match(get('toast').textContent,/reiniciar/);
});

test('the registry keeps completed counts separate from pending marks, even with no selected photo',()=>{
  const {get,state,renderProgress}=ui();state.items=[];state.selectedId=null;
  state.progress=[{slug:'gates-of-olympus',purchases:{completed:2,pending:1,problems:0},antebets:{completed:1,pending:0,problems:1}}];
  renderProgress(true);
  const cells=get('progress-rows').children[0].children;
  assert.equal(cells[0].textContent,'gates-of-olympus');
  assert.equal(cells[1].textContent,'2');assert.equal(cells[2].textContent,'1');
  assert.match(get('progress-summary').textContent,/2 compras realizadas/);
});

test('history filters by provider and review flag, and shows the selected game tag',()=>{
 const {get,state,renderProgress}=ui();state.items[0].game_id=1;
 const game=(id,provider,flag)=>({id,provider,slug:'game-'+id,reviewRequestedAt:flag,purchases:{completed:0},antebets:{completed:0},pendingPaths:1});
 state.progress=[game(1,'pragmatic','2026-10-18'),game(2,'pragmatic',null),game(3,'bgaming','2026-10-18')];
 get('history-provider').value='pragmatic';get('history-review').checked=true;
 state.marks=[{x:.1,y:.2,kind:'click'}];renderProgress(true);
 assert.equal(get('progress-rows').children.length,1);
 assert.equal(get('review-game-btn').textContent,'★ Para revisar');
 assert.equal(state.marks.length,1);
 get('history-review').checked=false;renderProgress(true);assert.equal(get('progress-rows').children.length,2);
});

test('a live base photo permits menu and antebet marks as independent branches',()=>{
  const {get,state}=ui();state.items[0].live=true;state.items[0].branchable=true;
  get('image-wrap').events.click({button:0,clientX:100,clientY:100});
  get('image-wrap').events.contextmenu({clientX:300,clientY:200,preventDefault(){}});
  assert.deepEqual(Array.from(state.marks,m=>m.kind),['click','antebet']);
});

test('ordinary clicks have optional operator notes and no category selector',()=>{
  const {get,state}=ui();get('image-wrap').events.click({button:0,clientX:100,clientY:100});
  const note=get('mark-list').children[0].children[0].children.find(c=>c?.placeholder==='Nota opcional');
  note.value='Abrir segundo menú';note.events.input();assert.equal(state.marks[0].label,'Abrir segundo menú');
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/data-mode=/);assert.match(html,/id="finish-btn"/);
});

test('antebet notices explain the pending step without claiming an interrupted spin never started',()=>{
  const {antebetNotice}=ui();
  assert.equal(antebetNotice({antebet:{phase:'done'}}),'');assert.equal(antebetNotice({}),'');
  assert.match(antebetNotice({antebet:{phase:'verify'}}),/confirmar que se activó/);
  assert.match(antebetNotice({antebet:{phase:'close'}}),/salir del menú.*No hice la tirada/);
  assert.match(antebetNotice({antebet:{phase:'spin'}}),/botón de tirada/);
  assert.match(antebetNotice({antebet:{phase:'wait-spin'}}),/tirada se inició/);
});

test('finalization requires all other paths resolved and no unsaved clicks',()=>{
  const {get,state,canFinishGame,undo}=ui();state.items[0].slug='gates';
  const game={slug:'gates',pendingPaths:2,readyPaths:1};assert.equal(canFinishGame(game,state.items[0]),false);
  game.pendingPaths=1;assert.equal(canFinishGame(game,state.items[0]),true);
  state.progress=[game];get('image-wrap').events.click({button:0,clientX:100,clientY:100});
  assert.equal(get('finish-btn').disabled,true);undo();assert.equal(get('finish-btn').disabled,false);
  const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/<b>Clics libres<\/b>|Cada punto crea una rama/);
});


test('the queue shows one card per game even when there are multiple independent operations',()=>{
 const {get,state,renderQueue}=ui();state.items=[{id:3,game_id:1,slug:'game-a',provider:'test'},{id:4,game_id:1,slug:'game-a',provider:'test'},{id:5,game_id:2,slug:'game-b',provider:'test'}];state.selectedId=3;
 renderQueue();assert.equal(get('queue-list').children.length,2);assert.match(get('queue-counter').textContent,/2 juegos · 3 operaciones/);
});
test('waiting for the next result never silently changes to another game',()=>{
 const {state,selectFirst}=ui();state.items=[{id:5,game_id:2}];state.focusGameId=1;state.selectedId=null;selectFirst();assert.equal(state.selectedId,null);
 state.items.push({id:6,game_id:1});selectFirst();assert.equal(state.selectedId,6);
});
test('executed clicks are green read-only pins and never become new submitted marks',()=>{
 const {get,state,renderPins}=ui();state.items[0].previousClicks=[{id:8,x:.3,y:.4,label:'Tirada normal',onRoute:true}];renderPins();
 assert.equal(get('pins').children.length,1);assert.equal(get('pins').children[0].className,'pin previous-click');assert.equal(state.marks.length,0);assert.match(get('pins').children[0].title,/ya ejecutado/);
});


test('waiting on one game does not block requesting a screenshot on a second game',async()=>{
 const pending=[];const {context,state,updateCapture}=ui(async(url,options)=>new Promise(resolve=>pending.push({url,options,resolve})));
 context.refresh=async()=>{};state.items=[{id:1,game_id:1,slug:'a'},{id:2,game_id:2,slug:'b'}];state.selectedId=1;
 const first=updateCapture(60);state.selectedId=2;const second=updateCapture(30);
 assert.equal(pending.length,2);assert.equal(state.refreshing.size,2);assert.equal(JSON.parse(pending[0].options.body).waitSeconds,60);
 pending[0].resolve({ok:true,json:async()=>({})});await first;assert.equal(state.refreshing.has(1),false);assert.equal(state.refreshing.has(2),true);
 pending[1].resolve({ok:true,json:async()=>({})});await second;assert.equal(state.refreshing.size,0);
});

test('a rejected save preserves its screenshot, marks and selection and never creates success history',async()=>{
 const {context,state,commit}=ui(async()=>({ok:false,json:async()=>({error:'Esperá la captura nueva antes de enviar clics'})}));context.refresh=async()=>{};
 state.items=[{id:11,game_id:7,slug:'test-game',provider:'test',capture:{capturedAt:'old'}}];state.selectedId=11;state.marks=[{x:.2,y:.3,kind:'click'}];
 await commit();assert.equal(state.selectedId,11);assert.equal(state.marks.length,1);assert.equal(state.history.length,0);assert.equal(state.items[0].id,11);assert.match(state.saveError,/conservaron/);
});
test('server-side capture refresh disables save even after the page has been reopened',()=>{
 const {context,state,get}=ui();state.items=[{id:11,game_id:7,slug:'game',provider:'test'}];state.selectedId=11;state.serverRefreshing.add(11);context.renderCaptureWait();assert.equal(get('save-btn').disabled,true);assert.equal(get('cloud-wait').disabled,true);
});

test('executed click indicators are green and text action lists stay hidden',()=>{
 const css=fs.readFileSync(new URL('../public/style.css',import.meta.url),'utf8'),html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(css,/\.previous-click\{[^}]*#7aff9a/);assert.match(html,/id="action-history" hidden/);assert.match(html,/id="mark-list"[^>]*hidden/);assert.match(html,/Verde: clic ya ejecutado aquí/);assert.match(html,/Azul: marca nueva sin ejecutar/);
 const {get,state,renderPins}=ui();state.items[0].previousClicks=[{id:2,x:.25,y:.75,label:'Clic',onRoute:true}];renderPins();const pin=get('pins').children[0];assert.equal(pin.style.left,'25%');assert.equal(pin.style.top,'75%');assert.equal(pin.textContent,'✓');assert.match(get('marks-count').textContent,/1 clics realizados aquí/);
});


