import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {inspectPragmatic} from './pragmatic-scan.js';
import {imageSignature,signatureDiff} from './visual.js';
import {providerFor,publicDemoUrl} from './providers.js';
import {dismissEntryOverlays,preferenceState} from './entry-overlays.js';
import {readGameText,gameStartEvidence} from './game-start.js';
import {readEntryIssue,startupNetworkIssue,ENTRY_ISSUE_TEXT} from './entry-issues.js';
import {entryCatalog} from './entry-catalog.js';
import {captureOf,controlForMark,captureState,captureNeedsLive,markNeedsLive,gameDecisionReady} from './actions.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export class ReplayError extends Error {constructor(code,detail=''){super(`${code}${detail?': '+detail:''}`);this.code=code;}}

export class BrowserEngine {
  constructor(config,db,{chromiumLoader=async()=>({chromium:(await import('playwright')).chromium}),screenReader=readGameText}={}){
    this.config=config;this.db=db;this.browser=null;this.launchPromise=null;this.chromiumLoader=chromiumLoader;this.screenReader=screenReader;
    this.live=new Map();this.metrics={sessionsOpened:0,screenshots:0,bytes:0,clicks:0,started:null,lastRenderer:'unknown',failures:0};
    this.reservations=new Set();this.busyParents=new Set();this.pendingLiveRoots=new Set();this.entryPreferences=new Map();
    this.resolveEntry=entryCatalog(config.featureCatalogFile||path.join(config.dataDir||'.','tester-spin-features.json'));
  }
  async start(){
    if(this.browser?.isConnected?.()===false)this.browser=null;
    if(this.browser)return;
    if(this.launchPromise)return this.launchPromise;
    this.launchPromise=this.launchOne();
    try{await this.launchPromise;}finally{this.launchPromise=null;}
  }
  async launchOne(){
    let chromium;
    try{({chromium}=await this.chromiumLoader());}catch{throw Error('Install dependencies first: npm install && npx playwright install chromium');}
    const args=[];
    if(this.config.gpuMode==='d3d11'){
      if(process.platform!=='win32')throw Error('GPU_MODE=d3d11 requires Windows');
      args.push('--use-angle=d3d11','--enable-gpu-rasterization');
    }else if(this.config.gpuMode==='auto'){
      // Chromium chooses ANGLE/D3D11 on compatible Windows hardware; no --disable-gpu.
    }else if(this.config.gpuMode!=='default')throw Error('GPU_MODE must be auto, d3d11, or default');
    this.browser=await chromium.launch({headless:this.config.headless,args});
    this.metrics.started=new Date().toISOString();
  }
  async stop(){for(const lease of this.live.values())await this.dispose(lease);this.live.clear();
    if(this.browser){await this.browser.close();this.browser=null;}
  }
  hasLive(taskId){return this.live.has(taskId);}
  liveCount(){return this.live.size;}
  async release(taskId){const lease=this.live.get(taskId);if(lease){this.live.delete(taskId);await this.dispose(lease);return true;}return false;}
  canPrepare(task){
    if(this.live.has(task.id))return !this.reservations.has(task.id);
    if(!task.parent_task_id)return !this.pendingLiveRoots.has(task.id)||this.live.size+this.reservations.size<(this.config.maxLive??4);
    if(!task.fresh_start&&!task.replay_branch&&this.busyParents.has(task.parent_task_id))return false;
    if(!task.fresh_start&&!task.replay_branch&&this.live.has(task.parent_task_id))return true;
    const steps=this.db.lineage(task.id);
    if(!task.replay_branch&&(steps.some(x=>captureNeedsLive(captureOf(x.parent)))||steps.slice(0,-1).some(x=>markNeedsLive(captureOf(x.parent),x.mark))))return true;
    return this.live.size+this.reservations.size<(this.config.maxLive??4);
  }
  async fresh(url){
    url=publicDemoUrl(url);
    await this.start();
    const ctxOptions={viewport:{width:this.config.viewportWidth,height:this.config.viewportHeight},deviceScaleFactor:1,serviceWorkers:'allow',acceptDownloads:false};
    const provider=providerFor(url);
    if(this.config.dataDir){
      if(!this.entryPreferences.has(provider)){
        const saved=await fs.readFile(path.join(this.config.dataDir,`entry-preferences-${provider}.json`),'utf8').then(JSON.parse).catch(()=>null);
        this.entryPreferences.set(provider,preferenceState(saved));
      }
      ctxOptions.storageState=this.entryPreferences.get(provider);
    }
    const context=await this.browser.newContext(ctxOptions);
    const page=await context.newPage();this.metrics.sessionsOpened++;
    const session={context,page,events:[],created:Date.now(),url,entryUrl:await this.resolveEntry(url)};
    page.on('requestfailed',request=>{const issue=startupNetworkIssue(provider,request.url());if(issue)session.entryIssue=issue;});
    page.on('response',response=>{
      const u=(()=>{try{const v=new URL(response.url());return `${v.origin}${v.pathname}`;}catch{return ''}})();
      if(session.events.length>=160)session.events.shift();
      session.events.push({url:u,status:response.status(),at:Date.now()});
    });
    try{await this.enter(session);return session;}
    catch(e){await this.dispose(session);throw e;}
  }
  async dispose(session){
    if(session?.preferenceChanged&&this.config.dataDir&&session.context?.storageState){
      try{
        const provider=providerFor(session.url),state=preferenceState(await session.context.storageState());
        this.entryPreferences.set(provider,state);
        await fs.mkdir(this.config.dataDir,{recursive:true});
        const file=path.join(this.config.dataDir,`entry-preferences-${provider}.json`),tmp=file+'.'+randomUUID()+'.tmp';
        await fs.writeFile(tmp,JSON.stringify(state));await fs.rename(tmp,file);
      }catch{/* Preference caching never interrupts a game or its cleanup. */}
    }
    if(session?.context)await session.context.close().catch(()=>{});
  }
  async dismissConsent(session){
    let handled=0;
    for(const frame of session.page.frames()){
      if(frame.isDetached?.())continue;
      try{
        const result=await frame.evaluate(dismissEntryOverlays);
        handled+=(result?.cookies||0)+(result?.age||0);
        if(result?.cookies||result?.age)session.preferenceChanged=true;
        this.metrics.consentDismissed=(this.metrics.consentDismissed||0)+(result?.cookies||0);
        this.metrics.ageConfirmed=(this.metrics.ageConfirmed||0)+(result?.age||0);
        if(result?.age)session.ageConfirmed=true;
      }catch{/* Navigating or detached frames are retried on the next observation. */}
    }
    return handled;
  }
  async enter(session){
    const page=session.page;
    if(providerFor(session.url)!=='pragmatic')return this.enterGeneric(session);
    await page.goto(session.url,{waitUntil:'domcontentloaded',timeout:35000});
    // Only catalog-site controls; never bypass authentication or click inside a real-money account.
    const demo=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]');
    const buttons=[page.getByRole('button',{name:/play demo|jugar demo|probar demo/i}),page.locator('[data-play-demo-open]')];
    let launchedDemo=false;
    const entryDeadline=Date.now()+13000;
    while(Date.now()<entryDeadline){
      await this.dismissConsent(session);
      if(await demo.count())break;
      if(!launchedDemo){
        for(const button of buttons){if(await button.count()){
          launchedDemo=await button.first().click({timeout:1300}).then(()=>true).catch(()=>false);
          if(launchedDemo)break;
        }}
      }
      await sleep(220);
    }
    // Runtime controls can appear BEFORE the loading screen and intro finish.
    // Never publish the catalog page or a transient runtime as a ready game.
    const initial=await this.waitForGameReady(session,{allowManual:true});
    session.manualReason=initial.manualReason||null;
    try{const renderer=await page.evaluate(()=>{
      const c=document.createElement('canvas');const gl=c.getContext('webgl2')||c.getContext('webgl');
      return gl?.getParameter(gl.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL)||'unreported';
    });this.metrics.lastRenderer=String(renderer).slice(0,160);}catch{}
  }
  async observe(session){
    if(providerFor(session.url)&&providerFor(session.url)!=='pragmatic')return this.observeGeneric(session);
    const page=session.page;
    const iframe=page.locator('iframe[src*="demogamesfree.pragmaticplay.net"]').first();
    let frame=null,bounds=null;
    if(await iframe.count()){
      bounds=await iframe.boundingBox().catch(()=>null);
      const handle=await iframe.elementHandle().catch(()=>null);
      frame=handle?await handle.contentFrame().catch(()=>null):null;
    }
    let scan={supported:false,state:'UNKNOWN',controls:[]};
    if(frame){try{scan=await frame.evaluate(inspectPragmatic);}catch{}}
    scan.state=captureState(scan);
    const clip=bounds&&bounds.width>=200&&bounds.height>=150
      ?this.clipForBounds(bounds)
      :{x:0,y:0,width:this.config.viewportWidth,height:this.config.viewportHeight};
    const controls=(scan.controls||[]).map(c=>{
      const sx=bounds&&scan.viewport?.width?bounds.width/scan.viewport.width:1;
      const sy=bounds&&scan.viewport?.height?bounds.height/scan.viewport.height:1;
      const hit=c.hit?{x:(c.hit.x*sx+(bounds?.x||0)-clip.x)/clip.width,
        y:(c.hit.y*sy+(bounds?.y||0)-clip.y)/clip.height,
        w:c.hit.w*sx/clip.width,h:c.hit.h*sy/clip.height}:null;
      return {path:c.path,name:c.name,texts:c.texts,handlers:c.handlers,hit};
    });
    const signature=scan.supported?`${scan.loading}|${scan.state}|${controls.filter(c=>c.hit).map(c=>c.path).sort().join('|')}`:null;
    return {clip,controls,state:scan.state,signature,frameUrl:frame?.url()||null,scan};
  }
  adoptDemoPopup(session){
    const pages=session.context?.pages?.()||[];
    session.entryPagesSeen||=new Set([session.page]);
    for(const page of pages){if(page===session.page||session.entryPagesSeen.has(page)||page.isClosed())continue;
      try{const u=new URL(page.url());if(u.protocol==='https:'&&(/\/(?:demo|FUN)(?:[/?]|$)|[?&](?:mode|moneymode|playMode)=(?:fun|demo)(?:&|$)/i.test(u.href)||providerFor(u.href)===providerFor(session.url)&&/\/games\/play\//.test(u.pathname))){session.page=page;session.entryPagesSeen.add(page);session.demoLaunched=true;return;}}catch{}
    }
  }
  async enterGeneric(session){
    await session.page.goto(session.entryUrl||session.url,{waitUntil:'domcontentloaded',timeout:35000});
    const until=Date.now()+(this.config.entryTimeoutMs??30000),clickedLaunchers=new Set();
    const launchReadyAt=Date.now()+(this.config.entryLaunchDelayMs??2000);
    while(Date.now()<until){
      this.adoptDemoPopup(session);
      await this.dismissConsent(session);
      let issue=await session.page.evaluate(readEntryIssue).catch(()=>null);
      if(!issue)for(const frame of session.page.frames().slice(1)){
        const host=await frame.frameElement().catch(()=>null),rect=await host?.boundingBox().catch(()=>null);
        if(rect?.width>=200&&rect?.height>=150){issue=await frame.evaluate(readEntryIssue).catch(()=>null);if(issue)break;}
      }
      if(issue){session.entryIssue=issue;session.manualReason=ENTRY_ISSUE_TEXT[issue];return;}
      const observed=await this.observeGeneric(session);
      if(observed.frameUrl&&!observed.entryReview)break;
      if(Date.now()<launchReadyAt){await sleep(200);continue;}
      const demo=session.page.getByRole('button',{name:/^(?:play demo|try demo|play for fun|jugar demo|demo|try game|play game|play now|try now|launch game)$/i});
      const link=session.page.getByRole('link',{name:/^(?:play demo|try demo|play for fun|jugar demo|demo|try game|play game|play now|try now)$/i});
      const tryIt=session.page.getByText(/^try it$/i,{exact:true});
      const belatra=providerFor(session.url)==='belatra'?session.page.getByRole('button',{name:/^jugar ahora$/i}):null;
      const yggdrasil=providerFor(session.url)==='yggdrasil'?session.page.getByRole('link',{name:/^play$/i}):null;
      const provider=providerFor(session.url);
      const play=['elk','wazdan','redtiger','quickspin','thunderkick','playngo','pgsoft'].includes(provider)?session.page.getByText(/^play$/i,{exact:true}):null;
      const desktop=provider==='greentube'?session.page.locator('#demo-desktop'):null;
      const custom=session.page.getByText(/^(?:play demo|try demo|play game|play for free)$/i,{exact:true});
      for(const locator of [demo,link,tryIt,belatra,yggdrasil,play,desktop,custom].filter(Boolean)){
        if(await locator.count()&&await locator.first().isVisible()){
          const key=await locator.first().evaluate(el=>(el.textContent||'').replace(/\s+/g,' ').trim().toLowerCase()+'|'+(el.getAttribute('href')||''));
          if(clickedLaunchers.has(key))continue;
          const popup=session.page.waitForEvent('popup',{timeout:1500}).catch(()=>null);
          const clicked=await locator.first().click({timeout:1500}).then(()=>true).catch(()=>false);if(clicked){session.demoLaunched=true;clickedLaunchers.add(key);}
          const opened=await popup;if(opened)session.page=opened;
          break;
        }
      }
      await sleep(500);
    }
    const initial=await this.ensureGenericStarted(session);
    if(initial.entryReview&&!session.demoLaunched&&['blueprint','pgsoft','wazdan','games_global'].includes(providerFor(session.url)))session.entryIssue='NO_PUBLIC_DEMO';
    session.manualReason=session.entryIssue?ENTRY_ISSUE_TEXT[session.entryIssue]:initial.entryReview?'Acceso a demo pendiente. Revisá esta pantalla para abrir el juego.':session.genericRunning?'Juego iniciado. Marcá las opciones que quieras analizar.':'Inicio pendiente: no pude confirmar que el juego haya comenzado.';
  }
  async ensureGenericStarted(session){
    const deadline=Date.now()+(this.config.gameStartTimeoutMs??45000),clicked=new Set();let last;
    const dir=path.join(this.config.dataDir,'tmp');await fs.mkdir(dir,{recursive:true});
    let file=null;
    try{
      while(Date.now()<deadline){
        this.adoptDemoPopup(session);
        await this.dismissConsent(session);last=await this.observeGeneric(session);
        if(last.entryReview){if(session.demoLaunched){await sleep(this.config.gameStartPollMs??1000);continue;}return last;}
        if(!last.frameUrl){await sleep(this.config.gameStartPollMs??1000);continue;}
        // WinRT OCR can retain a Windows file handle briefly after returning.
        // Never overwrite an image that was handed to the OCR process.
        file=path.join(dir,`intro-${randomUUID()}.jpg`);
        await session.page.screenshot({type:'jpeg',quality:75,clip:last.clip,path:file,timeout:12000});
        let evidence;
        try{evidence=gameStartEvidence(await this.screenReader(file,{provider:providerFor(session.url)}),{provider:providerFor(session.url)});}catch(e){session.startupError=String(e.message).slice(0,160);break;}
        await fs.rm(file,{force:true}).catch(()=>{});file=null;
        if(evidence.state==='BLOCKED'){session.entryIssue=evidence.issue;return last;}
        if(evidence.state==='RUNNING'&&Date.now()>=(session.readyNotBefore||0)){
          session.genericRunning=true;session.entryIssue=null;return last;
        }
        if(['INTRO','SETUP'].includes(evidence.state)&&!clicked.has(evidence.start.text)&&clicked.size<3){
          const h=evidence.start,x=last.clip.x+(h.x+h.w/2)*last.clip.width,y=last.clip.y+(h.y+h.h/2)*last.clip.height;
          if(this.inClip(last.clip,x,y)){
            clicked.add(h.text);await session.page.mouse.click(x,y);this.metrics.introsAdvanced=(this.metrics.introsAdvanced||0)+1;
            session.readyNotBefore=Date.now()+(this.config.postClickDelayMs??4500);
            await sleep(this.config.postClickDelayMs??4500);continue;
          }
        }
        await sleep(this.config.gameStartPollMs??1000);
      }
      session.genericRunning=false;return last||await this.observeGeneric(session);
    }finally{if(file)await fs.rm(file,{force:true}).catch(()=>{});}
  }
  async observeGeneric(session){
    for(const frame of session.page.frames()){
      if(frame.isDetached?.())continue;
      let inherited=frame;while(/^about:(?:blank|srcdoc)$/.test(inherited.url())&&inherited.parentFrame())inherited=inherited.parentFrame();
      const url=inherited.url();
      if(/hcaptcha\.com|challenges\.cloudflare\.com|google\.com\/recaptcha|youtube\.com|player\.vimeo\.com/i.test(url))continue;
      const playtechDemo=providerFor(session.url)==='playtech'&&new URL(session.url).searchParams.get('real')==='0'&&/^https:\/\/(?:cachedownload|gpas-games)\.playtechone\.com\//i.test(url);
      const publicEmbed=providerFor(session.url)==='3oaks'&&/^https:\/\/3oaks\.com\/api\/v1\/games\/[^/]+\/play/.test(url)||providerFor(session.url)==='rubyplay'&&session.ageConfirmed&&/^https:\/\/prrpeu3\.com\/launcher/.test(url);
      if(!/^https:\/\//i.test(url)||!(/demo|freeplay=true|\/FUN(?:[/?]|$)|\/free-slot\.|[?&](?:moneymode|mode)=(?:fun|demo)(?:&|$)/i.test(url)||playtechDemo||publicEmbed||session.demoLaunched))continue;
      const canvases=frame.locator('canvas');
      let canvas=null,bounds=null;
      let hostBounds=null;
      // A canvas inside a hidden catalog modal is not a running game.
      if(frame.parentFrame()){
        const host=await frame.frameElement().catch(()=>null);
        if(host){const visible=await host.evaluate(el=>{for(let n=el;n;n=n.parentElement){const s=getComputedStyle(n);if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;}return true;}).catch(()=>false);if(!visible)continue;
          await host.evaluate((el,height)=>{el.scrollIntoView({block:'center',inline:'nearest'});const r=el.getBoundingClientRect();if(r.y>=0&&r.bottom>height&&r.y<height-240)el.style.height=Math.floor(height-r.y-8)+'px';},this.config.viewportHeight).catch(()=>{});
          hostBounds=await host.boundingBox().catch(()=>null);
        }
      }
      for(const candidate of await canvases.all().catch(()=>[])){
        const rect=await candidate.boundingBox({timeout:1000}).catch(()=>null);
        if(rect&&rect.width>=200&&rect.height>=150&&(!bounds||rect.width*rect.height>bounds.width*bounds.height)){canvas=candidate;bounds=rect;}
      }
      if(!canvas){
        if(hostBounds&&hostBounds.width>=200&&hostBounds.height>=150&&!/^about:/.test(frame.url()))return {clip:this.clipForBounds(hostBounds),controls:[],state:'UNKNOWN',signature:null,frameUrl:url,scan:{supported:false,loading:null}};
        continue;
      }
      await canvas.scrollIntoViewIfNeeded?.({timeout:1200}).catch(()=>{});
      bounds=await canvas.boundingBox({timeout:1000}).catch(()=>null);
      if(!bounds||bounds.width<200||bounds.height<150)continue;
      const clip=this.clipForBounds(bounds);
      return {clip,controls:[],state:'UNKNOWN',signature:`manual|${new URL(url).origin}|${clip.width}|${clip.height}`,frameUrl:url,scan:{supported:false,loading:false}};
    }
    const entry=providerFor(session.page.url())===providerFor(session.url)&&!!providerFor(session.url);
    return {clip:{x:0,y:0,width:this.config.viewportWidth,height:this.config.viewportHeight},controls:[],state:'UNKNOWN',signature:null,frameUrl:entry?session.page.url():null,entryReview:entry,scan:{supported:false,loading:null}};
  }
  clipForBounds(rect){const W=this.config.viewportWidth,H=this.config.viewportHeight;
    const x=Math.max(0,Math.min(W-1,Math.floor(rect.x))),y=Math.max(0,Math.min(H-1,Math.floor(rect.y)));
    return {x,y,width:Math.max(1,Math.min(W-x,Math.ceil(rect.width))),height:Math.max(1,Math.min(H-y,Math.ceil(rect.height)))};
  }
  async settle(session,oldState){
    const until=Date.now()+4300;let previous='',matches=0,last=null;
    while(Date.now()<until){last=await this.observe(session);
      if(last.signature&&last.signature===previous)matches++;else matches=0;
      if(matches>=1 && (last.signature!==oldState || Date.now()>until-2500))break;
      previous=last.signature||'';await sleep(230);
    }
    return last||await this.observe(session);
  }
  async waitForGameReady(session,{timeoutMs=this.config.gameReadyTimeoutMs??90000,stableMs=2000,pollMs=250,expectedCapture=null,expectedControl=null,afterSignature=null,allowManual=false}={}){
    const started=Date.now();
    const deadline=Date.now()+timeoutMs;
    let signature=null,stableSince=Date.now(),last=null,nextIntroClick=0,transitioned=!afterSignature;
    while(Date.now()<deadline){
      await this.dismissConsent(session);
      last=await this.observe(session);
      if(afterSignature&&last.signature&&last.signature!==afterSignature){transitioned=true;session.pendingTransition=null;}
      const actionable=last.scan?.supported&&last.controls.some(c=>c.hit&&c.hit.w>0&&c.hit.h>0);
      if(!actionable||!last.signature||last.signature!==signature){
        signature=actionable?last.signature:null;stableSince=Date.now();
      }else if(Date.now()-stableSince>=stableMs&&Date.now()>=(session.readyNotBefore||0)){
        if(last.state==='INTRO'&&!expectedCapture){
          // Only a uniquely identified intro/start control may be pressed automatically.
          if(Date.now()>=nextIntroClick){
            await this.openKnownIntro(session);
            nextIntroClick=Date.now()+3000;
            signature=null;stableSince=Date.now();
          }
        }else if(transitioned&&gameDecisionReady(last)&&(!expectedCapture||captureState(last)===captureState(expectedCapture))&&
          (!expectedControl||last.controls.some(c=>c.hit&&c.hit.w>0&&c.hit.h>0&&c.path===expectedControl.path)))return last;
      }
      const spinning=last.controls.some(c=>c.hit&&/StopSpin_Button/i.test(c.path));
      if(allowManual&&!spinning&&Date.now()>=(session.readyNotBefore||0)&&last.frameUrl&&last.scan?.loading!==true&&Date.now()-started>=(this.config.manualReviewAfterMs??15000)&&!gameDecisionReady(last))
        return {...last,manualReview:true,manualReason:'No reconocí esta pantalla. Continuá con un clic manual.'};
      await sleep(Math.min(pollMs,Math.max(0,deadline-Date.now())));
    }
    if(allowManual&&last?.frameUrl)return {...last,manualReview:true,manualReason:'La pantalla necesita revisión manual. Marcá dónde continuar.'};
    if(expectedCapture&&captureState(last)!==captureState(expectedCapture))
      throw new ReplayError('STATE_MISMATCH',`expected ${captureState(expectedCapture)}, got ${last?.state||'UNKNOWN'} after waiting ${timeoutMs} ms`);
    if(expectedControl&&!last?.controls.some(c=>c.hit&&c.path===expectedControl.path))throw new ReplayError('CONTROL_MISSING',expectedControl.path);
    throw new ReplayError('GAME_NOT_READY',`DEMO did not reach an interactive state within ${timeoutMs} ms (state=${last?.state||'UNKNOWN'})`);
  }
  async openKnownIntro(session){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    if(view.state!=='INTRO')return {opened:false,view};
    const candidates=view.controls.filter(c=>c.hit &&
      /PlayButtonIntro|IntroScreen\/.*(?:Play|Start)(?:Spin)?_?Button/i.test(c.path));
    if(candidates.length!==1)return {opened:false,view};
    const h=candidates[0].hit;
    const x=view.clip.x+(h.x+h.w/2)*view.clip.width;
    const y=view.clip.y+(h.y+h.h/2)*view.clip.height;
    if(!this.inClip(view.clip,x,y))return {opened:false,view};
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    const result=await this.settle(session,view.signature);
    return {opened:result.state!=='INTRO',view:result};
  }
  async openKnownBuyMenu(session){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    if(view.state==='BUY_MENU')return {opened:true,view};
    if(view.state!=='BASE')return {opened:false,view};
    const buys=view.controls.filter(c=>c.hit&&/FeaturePurchase\/MainButton|BuyFeature\/MainButton/i.test(c.path));
    if(buys.length!==1)return {opened:false,view};
    const h=buys[0].hit;
    const x=view.clip.x+(h.x+h.w/2)*view.clip.width;
    const y=view.clip.y+(h.y+h.h/2)*view.clip.height;
    if(!this.inClip(view.clip,x,y))return {opened:false,view};
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    const result=await this.waitForGameReady(session,{expectedCapture:{state:'BUY_MENU',controls:[]}});
    if(result.state==='BUY_MENU')return {opened:true,view:result};
    return {opened:false,view:result};
  }
  inClip(clip,x,y){return x>=clip.x&&y>=clip.y&&x<clip.x+clip.width&&y<clip.y+clip.height;}
  async clickMark(session,parentCapture,mark,{onStarted}={}){
    session.actionStarted=false;
    const expected=parentCapture;
    const intended=controlForMark(expected,mark);
    const replayableRoot=Boolean(expected?.replayableRoot);
    const manual=Boolean(expected?.manualReview&&!replayableRoot);
    if(manual&&(!session.manualToken||session.manualToken!==expected.manualToken))throw new ReplayError('MANUAL_SESSION_REQUIRED');
    const current=manual||replayableRoot?await this.observe(session):await this.waitForGameReady(session,{expectedCapture:expected,expectedControl:intended});
    if(manual){
      if(!current.frameUrl||current.frameUrl!==expected.frameUrl)throw new ReplayError('MANUAL_SESSION_REQUIRED','La pantalla cambió');
    }else if(!replayableRoot&&intended && current.scan?.supported){
      const candidates=current.controls.filter(c=>c.path===intended.path&&c.hit);
      if(candidates.length!==1)throw new ReplayError('CONTROL_MISSING',intended.path);
      const h=candidates[0].hit;
      if(h.w<=0||h.h<=0)throw new ReplayError('CONTROL_NOT_VISIBLE');
      // Preserve the operator's fractional position WITHIN the control when layout changed.
      const rx=Math.max(0.02,Math.min(.98,(mark.x-intended.hit.x)/intended.hit.w));
      const ry=Math.max(0.02,Math.min(.98,(mark.y-intended.hit.y)/intended.hit.h));
      mark={...mark,x:h.x+h.w*rx,y:h.y+h.h*ry};
    }else if(!replayableRoot&&!current.scan?.supported && expected?.state!=='UNKNOWN'){
      throw new ReplayError('RUNTIME_UNAVAILABLE');
    }else{
      // A visually cataloged coordinate without a runtime control must match
      // a small visual signature before clicking. GPU/browser animations may
      // make matches less stable; prefer blocking over a wrong irreversible click.
      if(!expected?.visualKey)throw new ReplayError('UNVERIFIED_COORDINATE','no state signature saved');
      const pixels=await session.page.screenshot({type:'jpeg',quality:38,clip:current.clip,timeout:12000});
      const key=await imageSignature(pixels);
      const distance=signatureDiff(key,expected.visualKey);
      if(distance>this.config.visualTolerance)throw new ReplayError('VISUAL_STATE_MISMATCH',`distance ${distance.toFixed(3)} > ${this.config.visualTolerance}`);
    }
    if(!Number.isFinite(mark.x)||!Number.isFinite(mark.y)||mark.x<0||mark.x>1||mark.y<0||mark.y>1)throw new ReplayError('INVALID_MARK');
    const x=current.clip.x+mark.x*current.clip.width,y=current.clip.y+mark.y*current.clip.height;
    if(!this.inClip(current.clip,x,y))throw new ReplayError('CLICK_OUTSIDE_DEMO');
    // Once a click starts, a failed wait must never cause it to be replayed.
    session.actionStarted=true;
    onStarted?.();
    session.pendingTransition=!manual&&!['antebet','antebet_toggle','click'].includes(mark.kind)&&markNeedsLive(expected,mark)?current.signature:null;
    await session.page.mouse.click(x,y);this.metrics.clicks++;
    session.readyNotBefore=Date.now()+(this.config.postClickDelayMs??4500);
    const result=await this.waitForGameReady(session,{timeoutMs:this.config.transitionTimeoutMs??180000,
      stableMs:this.config.postClickStableMs??3000,afterSignature:session.pendingTransition,allowManual:true});
    session.manualReason=result.manualReason||null;
    return result;
  }
  antebetEnabled(view,flow){
    const candidates=view.controls.filter(c=>c.hit&&(c.path===flow.path||/AnteBet|BetLevel/i.test(c.path)));
    const exact=candidates.find(c=>c.path===flow.path);
    const candidate=exact||(candidates.length===1?candidates[0]:null);
    const texts=(candidate?.texts||[]).map(s=>s.trim().toUpperCase());
    if(texts.includes('ON')&&!texts.includes('OFF'))return true;
    return false;
  }
  async runAntebet(session,parentCapture,mark){
    if(providerFor(session.url)&&providerFor(session.url)!=='pragmatic'){
      if(!session.antebetFlow){
        session.antebetFlow={phase:'activate'};
        await this.clickMark(session,parentCapture,{...mark,kind:'click'},{onStarted:()=>{session.antebetFlow.phase='verify';}});
      }
      session.manualReason='Antebet pulsado: verificá su activación y marcá la tirada. Este proveedor requiere revisión manual.';
      return;
    }
    const flow=session.antebetFlow||(session.antebetFlow={phase:'activate',path:controlForMark(parentCapture,mark)?.path||null});
    let current=await this.waitForGameReady(session,{afterSignature:session.pendingTransition||null});
    if(flow.phase==='activate'){
      if(this.antebetEnabled(current,flow))flow.phase='close';
      else{
        // Independent branches start at default settings. Match the ON/OFF
        // variants of the same switch, rather than replaying the old spin.
        const switchPath=p=>p?.replace(/Level_?[01](?=Button|\/|$)/g,'Level_*');
        if(flow.path&&!current.controls.some(c=>c.hit&&c.path===flow.path)){
          const variants=current.controls.filter(c=>c.hit&&/AnteBet|BetLevel/i.test(c.path)&&switchPath(c.path)===switchPath(flow.path));
          if(variants.length===1){
            const h=variants[0].hit;parentCapture=current;mark={...mark,x:h.x+h.w/2,y:h.y+h.h/2};flow.path=variants[0].path;
          }
        }
        // Advance BEFORE clicking, so recovery never toggles the same switch twice.
        current=await this.clickMark(session,parentCapture,{...mark,kind:'antebet'},{onStarted:()=>{flow.phase='verify';}});
      }
    }
    if(flow.phase==='verify'){
      if(!this.antebetEnabled(current,flow))return;
      flow.phase='close';
    }
    if(flow.phase==='close'){
      if(captureState(current)==='BUY_MENU'){
        const closes=current.controls.filter(c=>c.hit&&/PurchaseWindow\/.*CloseButton|FreeSpinsPurchase\/.*(?:CloseButton|ButtonClose)/i.test(c.path));
        if(closes.length!==1)return;
        const h=closes[0].hit;
        current=await this.clickMark(session,current,{x:h.x+h.w/2,y:h.y+h.h/2,kind:'navigate'});
        if(captureState(current)==='BUY_MENU')return;
      }
      if(captureState(current)!=='BASE')return;
      flow.phase='spin';
    }
    if(flow.phase==='spin'){
      const spins=current.controls.filter(c=>c.hit&&(/StartSpin_Button/i.test(c.path)||(c.handlers||[]).some(h=>/Pressed_Spin$/i.test(h))));
      if(spins.length!==1)return;
      const h=spins[0].hit;
      await this.clickMark(session,current,{x:h.x+h.w/2,y:h.y+h.h/2,kind:'spin'},{onStarted:()=>{flow.phase='wait-spin';}});
      flow.phase='done';
    }else if(flow.phase==='wait-spin'){
      // Reaching this point means the original spin's transition has settled.
      flow.phase='done';
    }
  }
  async screenshot(session,taskId,{rootMode='base',manualReason=null,actionApplied=true}={}){
    await this.dismissConsent(session);
    const view=await this.observe(session);
    if(manualReason&&!view.frameUrl)throw new ReplayError('GAME_NOT_READY','No hay un juego DEMO abierto para revisar');
    if(!manualReason&&!gameDecisionReady(view))
      throw new ReplayError('GAME_NOT_READY',`refusing incomplete capture (state=${view.state})`);
    const dir=path.join(this.config.dataDir,'shots');await fs.mkdir(dir,{recursive:true});
    const target=path.join(dir,`task-${taskId}.jpg`),tmp=target+'.tmp';
    const bytes=await session.page.screenshot({type:'jpeg',quality:this.config.jpegQuality,clip:view.clip,timeout:15000});
    await fs.writeFile(tmp,bytes);await fs.rename(tmp,target);
    this.metrics.screenshots++;this.metrics.bytes+=bytes.length;
    const visualKey=await imageSignature(bytes);
    if(manualReason)session.manualToken ||= randomUUID();
    return {file:target,capture:{visualKey,clip:view.clip,width:view.clip.width,height:view.clip.height,actionApplied,
      ...(manualReason?{manualReview:true,manualReason,manualToken:session.manualToken,entryReview:!!view.entryReview}:{}),
      startupVersion:2,gameRunning:session.genericRunning===true||!['INTRO','UNKNOWN'].includes(view.state),entryIssue:session.entryIssue||null,entryOverlaysVersion:1,rootMode,state:view.state,signature:view.signature,controls:view.controls,
      frameUrl:view.frameUrl,network:session.events.slice(-25),capturedAt:new Date().toISOString(),bytes:bytes.length}};
  }
  async prepare(task){
    const lineage=this.db.lineage(task.id);
    let requiresLive=lineage.some(x=>markNeedsLive(captureOf(x.parent),x.mark));
    const sourceParent=task.fresh_start||task.replay_branch?null:this.db.getTask(task.parent_task_id);
    const recovering=this.live.has(task.id);
    let session=this.live.get(task.id)||(sourceParent?this.live.get(sourceParent.id):null);
    const inherited=Boolean(session);
    if(!inherited&&!task.replay_branch&&(lineage.some(x=>captureNeedsLive(captureOf(x.parent)))||lineage.slice(0,-1).some(x=>markNeedsLive(captureOf(x.parent),x.mark))))
      throw new ReplayError('LIVE_SESSION_LOST','La sesión original del bonus ya no está disponible; no se repite la compra ni la tirada');
    if(sourceParent&&this.busyParents.has(sourceParent.id))throw new ReplayError('LIVE_SESSION_BUSY');
    const needsReservation=Boolean(task.parent_task_id||this.pendingLiveRoots.has(task.id));
    if(needsReservation&&!inherited&&this.live.size+this.reservations.size>=(this.config.maxLive??4))
      throw new ReplayError('LIVE_SLOTS_FULL');
    if(needsReservation&&!inherited)this.reservations.add(task.id);
    if(inherited&&sourceParent)this.busyParents.add(sourceParent.id);
    let success=false,atTarget=false;
    try{
      if(!session)session=await this.fresh(task.url);
      session.actionStarted=false;
      if(lineage.length&&!recovering)session.manualReason=null;
      let mode=recovering?session.rootMode||'base':'base';
      if(session.manualReason){requiresLive=true;}
      else if(recovering){
        requiresLive=true;
        if(session.antebetFlow){
          atTarget=true;
          const step=lineage.at(-1);
          await this.runAntebet(session,captureOf(step.parent),step.mark);
        }
      }
      else if(!lineage.length){
        const opened=await this.openKnownBuyMenu(session);
        mode=opened.opened?'menu':'base';
      }else{
        if(!inherited){
          const root=lineage[0].parent;
          const rootInfo=root.capture_json?JSON.parse(root.capture_json):{};
          if(rootInfo.rootMode==='menu'||captureState(rootInfo)==='BUY_MENU'){
            const opened=await this.openKnownBuyMenu(session);
            if(!opened.opened)throw new ReplayError('BUY_MENU_NOT_REOPENED');
          }
          // Replay previous *navigation* steps only, never a previous irreversible purchase.
          for(const step of lineage.slice(0,-1)){
            const previous=step.parent.capture_json?JSON.parse(step.parent.capture_json):{};
            if(step.mark.kind==='antebet'){
              delete session.antebetFlow;await this.runAntebet(session,previous,step.mark);
              if(session.antebetFlow.phase!=='done')throw new ReplayError('BRANCH_REBUILD_FAILED','Antebet de la ruta pendiente');
            }else await this.clickMark(session,previous,step.mark);
          }
        }
        const step=lineage.at(-1);
        const parentInfo=step.parent.capture_json?JSON.parse(step.parent.capture_json):{};
        atTarget=true;
        delete session.antebetFlow;
        if(step.mark.kind==='antebet')await this.runAntebet(session,parentInfo,step.mark);
        else await this.clickMark(session,parentInfo,step.mark);
        mode=parentInfo.rootMode==='menu'||captureState(captureOf(lineage[0].parent))==='BUY_MENU'?'menu':'base';
      }
      const finalView=session.manualReason?await this.observe(session):await this.waitForGameReady(session,{afterSignature:session.pendingTransition||null,allowManual:true});
      session.manualReason=finalView.manualReason||session.manualReason||null;
      if(!lineage.length)mode=finalView.state==='BUY_MENU'?'menu':'base';
      const result=await this.screenshot(session,task.id,{rootMode:mode,manualReason:session.manualReason});
      // Initial manual photos can be archived without keeping a browser alive.
      // A later operator click reopens the root and validates its pixels first.
      if(!lineage.length&&session.manualReason&&result.capture.state!=='BONUS'){
        result.capture.replayableRoot=true;requiresLive=false;
      }
      if(session.antebetFlow)result.capture.antebet={...session.antebetFlow};
      requiresLive=requiresLive||inherited||captureNeedsLive(result.capture);
      if(requiresLive&&!inherited&&!this.reservations.has(task.id)&&this.live.size+this.reservations.size>=(this.config.maxLive??4)){
        this.pendingLiveRoots.add(task.id);throw new ReplayError('LIVE_SLOTS_FULL');
      }
      result.capture.requiresLive=requiresLive;session.rootMode=mode;success=true;
      this.pendingLiveRoots.delete(task.id);
      if(requiresLive){
        if(inherited&&!recovering)this.live.delete(sourceParent.id);
        this.live.set(task.id,session);
      }
      return {...result,live:requiresLive};
    }catch(e){
      this.metrics.failures++;
      if(session&&['GAME_NOT_READY','STATE_MISMATCH','CONTROL_MISSING','RUNTIME_UNAVAILABLE','MANUAL_SESSION_REQUIRED'].includes(e.code)){
        const view=await this.observe(session);
        if(view.frameUrl){
          if(!inherited&&!this.reservations.has(task.id)&&this.live.size+this.reservations.size>=(this.config.maxLive??4)){
            this.pendingLiveRoots.add(task.id);throw new ReplayError('LIVE_SLOTS_FULL');
          }
          session.manualReason='No pude reconocer el siguiente paso. Marcá dónde continuar manualmente.';
          const result=await this.screenshot(session,task.id,{rootMode:session.rootMode||'base',manualReason:session.manualReason,actionApplied:atTarget&&Boolean(session.actionStarted)});
          result.capture.requiresLive=true;success=true;requiresLive=true;
          if(inherited&&!recovering)this.live.delete(sourceParent.id);
          this.live.set(task.id,session);this.pendingLiveRoots.delete(task.id);
          return {...result,live:true};
        }
      }
      if(task.replay_branch&&!atTarget)throw new ReplayError('BRANCH_REBUILD_FAILED',`No se pudo reconstruir el menú en otra sesión: ${e.message}`);
      if(session?.page?.isClosed?.()===true){
        this.live.delete(task.id);if(sourceParent)this.live.delete(sourceParent.id);
        throw new ReplayError('LIVE_SESSION_LOST','Se cerró el navegador de la sesión; no se repite ninguna acción aleatoria');
      }
      if(atTarget&&session?.actionStarted){
        if(inherited&&!recovering)this.live.delete(sourceParent.id);
        session.rootMode=session.rootMode||captureOf(lineage[0]?.parent).rootMode||'base';
        this.live.set(task.id,session);e.recoverable=true;
      }
      if(inherited)e.recoverable=true;
      throw e;
    }finally{
      this.reservations.delete(task.id);if(sourceParent)this.busyParents.delete(sourceParent.id);
      if(session&&!this.live.has(task.id)&&!inherited&&(!requiresLive||!success))await this.dispose(session);
    }
  }
}
