import {providerFor} from './providers.js';
import {DatabaseSync} from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import {demoUrl,gameSlug,normalizeMarks} from './config.js';
import {captureOf,captureState,classifyMark,captureNeedsLive,captureCanBranch,markNeedsLive} from './actions.js';

export class CatalogDB {
  constructor(dir,{sqliteCacheMb=256}={}){
    fs.mkdirSync(dir,{recursive:true});
    this.path=path.join(dir,'catalog.sqlite');
    this.db=new DatabaseSync(this.path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-${Math.round(sqliteCacheMb*1024)};`);
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS games(
      id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, slug TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks(
      id INTEGER PRIMARY KEY,
      game_id INTEGER NOT NULL REFERENCES games(id),
      parent_task_id INTEGER REFERENCES tasks(id),
      via_mark_id INTEGER,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'queued',
      capture_file TEXT,
      capture_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY(via_mark_id) REFERENCES marks(id)
    );
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status,depth DESC,id);
    CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id);
    CREATE INDEX IF NOT EXISTS tasks_game_status ON tasks(game_id,status);
    CREATE TABLE IF NOT EXISTS marks(
      id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id),
      ordinal INTEGER NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      kind TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      UNIQUE(task_id,ordinal)
    );
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='fresh_start'))
      this.db.exec('ALTER TABLE tasks ADD COLUMN fresh_start INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(tasks)').all().some(c=>c.name==='replay_branch'))
      this.db.exec('ALTER TABLE tasks ADD COLUMN replay_branch INTEGER NOT NULL DEFAULT 0');
    if(!this.db.prepare('PRAGMA table_info(games)').all().some(c=>c.name==='finished_at'))
      this.db.exec('ALTER TABLE games ADD COLUMN finished_at TEXT');
    if(!this.db.prepare('PRAGMA table_info(games)').all().some(c=>c.name==='provider'))
      this.db.exec("ALTER TABLE games ADD COLUMN provider TEXT NOT NULL DEFAULT 'pragmatic'");
    if(!this.db.prepare('PRAGMA table_info(games)').all().some(c=>c.name==='name'))
      this.db.exec("ALTER TABLE games ADD COLUMN name TEXT NOT NULL DEFAULT ''");
    if(!this.db.prepare('PRAGMA table_info(games)').all().some(c=>c.name==='review_requested_at'))
      this.db.exec('ALTER TABLE games ADD COLUMN review_requested_at TEXT');
    if(!this.db.prepare('PRAGMA table_info(games)').all().some(c=>c.name==='manual_requested_at'))
      this.db.exec('ALTER TABLE games ADD COLUMN manual_requested_at TEXT');
    // A crash cannot leave a permanent "preparing" lock.
    this.db.prepare("UPDATE tasks SET status='queued' WHERE status='preparing'").run();
  }
  close(){this.db.close();}
  refreshStartupAdapters(){
    if(this.getSetting('startup-adapters-v2',false))return 0;
    const result=this.db.prepare(`UPDATE tasks SET status='queued',error=NULL WHERE status='ready' AND parent_task_id IS NULL
      AND json_extract(capture_json,'$.gameRunning')=0 AND json_extract(capture_json,'$.replayableRoot')=1
      AND COALESCE(json_extract(capture_json,'$.requiresLive'),0)=0 AND COALESCE(json_extract(capture_json,'$.startupVersion'),0)<2
      AND NOT EXISTS(SELECT 1 FROM marks WHERE marks.task_id=tasks.id)
      AND game_id IN (SELECT id FROM games WHERE finished_at IS NULL)`).run();
    this.setSetting('startup-adapters-v2',true);return result.changes;
  }
  setReview(gameId,review){
    if(typeof review!=='boolean')throw Error('Review must be boolean');
    const result=this.db.prepare("UPDATE games SET review_requested_at=CASE WHEN ? THEN COALESCE(review_requested_at,datetime('now')) ELSE NULL END WHERE id=?").run(Number(review),gameId);
    if(!result.changes)throw Error('Game not found');
    return {gameId,reviewRequestedAt:this.db.prepare('SELECT review_requested_at FROM games WHERE id=?').get(gameId).review_requested_at};
  }
  setSetting(key,value){this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}
  getSetting(key,fallback){const r=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return r?JSON.parse(r.value):fallback;}
  refreshEntryReviews(){
    if(this.getSetting('entry-overlays-v1',false))return 0;
    let count=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const update=this.db.prepare("UPDATE tasks SET status='queued',error=NULL,updated_at=datetime('now') WHERE id=?");
      for(const task of this.db.prepare("SELECT * FROM tasks WHERE status='ready' AND parent_task_id IS NULL").all()){
        const capture=captureOf(task);
        if(capture.entryReview&&capture.replayableRoot&&!capture.requiresLive&&!capture.entryOverlaysVersion&&!this.marksForTask(task.id).length){update.run(task.id);count++;}
      }
      this.setSetting('entry-overlays-v1',true);this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return count;
  }
  importUrls(raw,{manual=false}={}){
    if(!Array.isArray(raw)||raw.length>20000)throw Error('Send an array of up to 20,000 URLs');
    const urls=[...new Set(raw.filter(x=>String(x).trim()).map(demoUrl))];
    const insertGame=this.db.prepare('INSERT OR IGNORE INTO games(url,slug,provider) VALUES(?,?,?)');
    const idFor=this.db.prepare('SELECT id FROM games WHERE url=?');
    const hasTask=this.db.prepare('SELECT id FROM tasks WHERE game_id=? AND parent_task_id IS NULL');
    const insertTask=this.db.prepare("INSERT INTO tasks(game_id,depth,status) VALUES(?,0,'queued')");
    let added=0,existing=0;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const url of urls){
        const provider=providerFor(url),slug=gameSlug(url);
        const alias=provider==='pragmatic'&&new URL(url).hostname==='www.pragmaticplay.com'?this.db.prepare('SELECT id FROM games WHERE provider=? AND slug=?').get(provider,slug.replace(/-slot$/,'')):null;
        if(alias){if(manual)this.db.prepare("UPDATE games SET manual_requested_at=datetime('now') WHERE id=?").run(alias.id);existing++;continue;}
        insertGame.run(url,slug,provider);const id=idFor.get(url).id;
        if(manual)this.db.prepare("UPDATE games SET manual_requested_at=datetime('now') WHERE id=?").run(id);
        if(hasTask.get(id))existing++;else {insertTask.run(id);added++;}
      }
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return {added,existing,unique:urls.length};
  }
  getTask(id){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.name FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.id=?`).get(id)||null;}
  getMark(id){return this.db.prepare('SELECT * FROM marks WHERE id=?').get(id)||null;}
  marksForTask(id){return this.db.prepare('SELECT * FROM marks WHERE task_id=? ORDER BY ordinal').all(id);}
  listReady(limit=100,provider=null){return this.db.prepare(`SELECT t.id,t.game_id,t.depth,t.status,t.capture_file,t.capture_json,t.updated_at,g.slug,g.url,g.provider,g.name,COUNT(m.id) as marks_count
  FROM tasks t JOIN games g ON t.game_id=g.id LEFT JOIN marks m ON m.task_id=t.id
  WHERE t.status='ready' AND (? IS NULL OR g.provider=?) GROUP BY t.id ORDER BY (g.manual_requested_at IS NOT NULL) DESC,t.depth DESC,t.id ASC LIMIT ?`).all(provider,provider,limit).map(x=>({...x,branchable:captureCanBranch(captureOf(x)),capture:x.capture_json?(({state,rootMode,capturedAt,bytes,antebet,manualReview,manualReason,entryReview,gameRunning,startupVersion})=>({state,rootMode,capturedAt,bytes,antebet,manualReview,manualReason,entryReview,gameRunning,startupVersion}))(JSON.parse(x.capture_json)):null,capture_json:undefined}));}
  listProblems(limit=100){return this.db.prepare(`SELECT t.id,t.depth,t.status,t.error,g.slug FROM tasks t JOIN games g ON t.game_id=g.id WHERE t.status IN ('failed','blocked') ORDER BY t.id DESC LIMIT ?`).all(limit);}
  stats(){
    const statuses=this.db.prepare('SELECT status,COUNT(*) as count FROM tasks GROUP BY status').all();
    const totals=this.db.prepare('SELECT COUNT(*) as games FROM games').get();
    const marks=this.db.prepare('SELECT COUNT(*) as marks FROM marks').get();
    return {games:totals.games,marks:marks.marks,tasks:Object.fromEntries(statuses.map(r=>[r.status,r.count]))};
  }
  gameProgress(){
    const games=this.db.prepare('SELECT id,slug,url,provider,name,finished_at,review_requested_at AS reviewRequestedAt FROM games ORDER BY slug').all();
    const rows=this.db.prepare(`SELECT t.*,m.kind,m.x,m.y FROM tasks t LEFT JOIN marks m ON m.id=t.via_mark_id ORDER BY t.id`).all();
    const tasks=new Map(),groups=new Map(games.map(g=>[g.id,{purchases:new Map(),antebets:new Map(),closed:0,pending:0,ready:0,problems:0}]));
    for(const task of rows){
      const parent=tasks.get(task.parent_task_id),capture=captureOf(task);
      const applied=Boolean(task.capture_json)&&capture.actionApplied!==false;
      const kind=task.via_mark_id?classifyMark(parent?.capture||{},{kind:task.kind,x:task.x,y:task.y}).kind:null;
      const group=groups.get(task.game_id);
      if(['queued','preparing','ready','failed','blocked'].includes(task.status))group.pending++;
      if(task.status==='ready')group.ready++;
      if(['failed','blocked'].includes(task.status))group.problems++;
      if(task.status==='completed')group.closed++;
      let purchase=parent?.purchase,antebet=parent?.antebet;
      if((kind==='buy'&&(!capture.flowCompletion?.version||!purchase||purchase.completed))||(kind==='confirm'&&!purchase)||(!purchase&&capture.flowCompletion?.purchasePending)){
        purchase={completed:false,problem:false};group.purchases.set(task.id,purchase);
      }
      if(['antebet','antebet_toggle'].includes(kind)){
        antebet={completed:false,problem:false};group.antebets.set(task.id,antebet);
      }
      // A purchase selection only opens confirmation; it is not yet a purchase.
      if(applied&&purchase&&capture.flowCompletion?.version&&capture.flowCompletion.terminalPurchase===true)purchase.completed=true;
      if(!capture.flowCompletion?.version&&applied&&purchase&&((kind==='confirm'&&['BASE','BONUS','BUY_MENU'].includes(captureState(capture)))||
        (kind==='buy'&&captureState(capture)==='BONUS')))purchase.completed=true;
      if(applied&&antebet&&capture.antebet?.phase==='done')antebet.completed=true;
      if(applied&&antebet){
        if(kind==='antebet_toggle')antebet.enabled=(capture.controls||[]).some(c=>c.hit&&/AnteBet|BetLevel/i.test(c.path)&&(c.texts||[]).some(s=>s.trim().toUpperCase()==='ON'));
        if(kind==='spin'&&antebet.enabled)antebet.completed=true;
      }
      if(['failed','blocked'].includes(task.status)){
        if(purchase)purchase.problem=true;if(antebet)antebet.problem=true;
      }
      tasks.set(task.id,{capture,purchase,antebet});
    }
    const counts=map=>{
      const values=[...map.values()];const completed=values.filter(x=>x.completed).length;
      const problems=values.filter(x=>!x.completed&&x.problem).length;
      return {marked:values.length,completed,pending:values.length-completed-problems,problems};
    };
    return games.map(g=>({...g,purchases:counts(groups.get(g.id).purchases),antebets:counts(groups.get(g.id).antebets),closedCaptures:groups.get(g.id).closed,
      pendingPaths:groups.get(g.id).pending,readyPaths:groups.get(g.id).ready,problemPaths:groups.get(g.id).problems,finishedAt:g.finished_at}));
  }
  nextQueued(){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.name,m.kind AS via_kind FROM tasks t
    JOIN games g ON g.id=t.game_id LEFT JOIN marks m ON m.id=t.via_mark_id
    WHERE t.status='queued' ORDER BY (t.depth>0) DESC,t.depth DESC,t.id ASC LIMIT 1`).get()||null;}
  queuedBatch(limit=50){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.name,m.kind AS via_kind FROM tasks t
    JOIN games g ON g.id=t.game_id LEFT JOIN marks m ON m.id=t.via_mark_id
    WHERE t.status='queued' ORDER BY (t.depth>0) DESC,t.depth DESC,t.id ASC LIMIT ?`).all(limit);}
  queuedRoots(limit=20){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.name,NULL AS via_kind FROM tasks t JOIN games g ON g.id=t.game_id
    WHERE t.status='queued' AND t.depth=0 ORDER BY t.id LIMIT ?`).all(limit);}
  providerBuffer(){
    return Object.fromEntries(this.db.prepare(`SELECT g.provider,COUNT(*) AS captures,COUNT(DISTINCT t.game_id) AS games
      FROM tasks t JOIN games g ON g.id=t.game_id WHERE (t.status IN ('ready','preparing') OR (t.capture_file IS NOT NULL AND t.status IN ('blocked','failed'))) AND g.finished_at IS NULL GROUP BY g.provider`).all().map(r=>[r.provider,{captures:r.captures,games:r.games}]));
  }
  bufferState(){
    return this.db.prepare(`SELECT
      COUNT(DISTINCT CASE WHEN t.status='ready' AND COALESCE(json_extract(t.capture_json,'$.gameRunning'),1)!=0 THEN t.game_id END) AS readyGames,
      COUNT(DISTINCT CASE WHEN t.status IN ('ready','preparing') THEN t.game_id END) AS coveredGames
      FROM tasks t JOIN games g ON g.id=t.game_id WHERE g.finished_at IS NULL`).get();
  }
  bufferRoots(limit=20){return this.db.prepare(`SELECT t.*,g.url,g.slug,g.provider,g.name,g.manual_requested_at,NULL AS via_kind FROM tasks t JOIN games g ON g.id=t.game_id
    WHERE t.status='queued' AND t.parent_task_id IS NULL AND g.finished_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM tasks other WHERE other.game_id=t.game_id AND other.status IN ('ready','preparing'))
      ORDER BY (g.manual_requested_at IS NOT NULL) DESC,t.id LIMIT ?`).all(limit);}
  claim(id){return this.db.prepare("UPDATE tasks SET status='preparing',updated_at=datetime('now'),error=NULL WHERE id=? AND status='queued'").run(id).changes===1;}
  ready(id,{capture_file,capture}){
    this.db.prepare("UPDATE tasks SET status='ready',capture_file=?,capture_json=?,error=NULL,updated_at=datetime('now') WHERE id=? AND status='preparing'").run(capture_file,JSON.stringify(capture),id);
  }
  fail(id,status,error){if(!['failed','blocked','queued'].includes(status))throw Error('Invalid failure status');
    this.db.prepare("UPDATE tasks SET status=?,error=?,updated_at=datetime('now') WHERE id=?").run(status,String(error).slice(0,600),id);
  }
  finish(id){
    const task=this.getTask(id);if(!task)throw Error('Task not found');
    if(!['ready','failed','blocked'].includes(task.status))throw Error('Task already cataloged or not ready');
    this.db.prepare("UPDATE tasks SET status='completed',updated_at=datetime('now') WHERE id=?").run(id);
    return {ok:true,taskId:id};
  }
  finishGame(gameId,currentTaskId=null){
    const game=this.db.prepare('SELECT * FROM games WHERE id=?').get(gameId);if(!game)throw Error('Game not found');
    const task=currentTaskId?this.getTask(currentTaskId):null;
    if(currentTaskId&&(!task||task.game_id!==gameId||task.status!=='ready'))throw Error('La captura actual no está lista para finalizar');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const {pending}=this.db.prepare(`SELECT COUNT(*) AS pending FROM tasks WHERE game_id=? AND status IN ('queued','preparing','ready','failed','blocked') AND id!=?`).get(gameId,currentTaskId||-1);
      if(pending)throw Error(`Quedan ${pending} caminos pendientes de este juego`);
      if(task)this.db.prepare("UPDATE tasks SET status='completed',updated_at=datetime('now') WHERE id=?").run(task.id);
      this.db.prepare("UPDATE games SET finished_at=COALESCE(finished_at,datetime('now')) WHERE id=?").run(gameId);
      this.db.exec('COMMIT');return {ok:true,gameId,taskId:task?.id||null};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // The photo receives all the marks at once. Every point creates an independent child job.
  commit(id,rawMarks){
    let marks=normalizeMarks(rawMarks);const task=this.getTask(id);
    if(!task)throw Error('Task not found');
    if(task.status!=='ready')throw Error('Task already cataloged or not ready');
    const capture=captureOf(task);
    const splitLive=captureNeedsLive(capture)&&marks.length>1;
    const independent=splitLive&&captureCanBranch(capture);
    marks=marks.map(mark=>classifyMark(capture,mark));
    if(task.depth>=24&&marks.length&&!independent)throw Error('Maximum route depth: 24');
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const addMark=this.db.prepare('INSERT INTO marks(task_id,ordinal,x,y,kind,label) VALUES(?,?,?,?,?,?)');
      const addTask=this.db.prepare("INSERT INTO tasks(game_id,parent_task_id,via_mark_id,depth,status,fresh_start,replay_branch) VALUES(?,?,?,?,'queued',?,?)");
      const children=[];
      marks.forEach((m,i)=>{const mr=addMark.run(id,i+1,m.x,m.y,m.kind,m.label);
        const tr=addTask.run(task.game_id,id,Number(mr.lastInsertRowid),independent?1:task.depth+1,independent?1:0,splitLive&&!independent&&i>0?1:0);
        children.push({taskId:Number(tr.lastInsertRowid),markId:Number(mr.lastInsertRowid),kind:m.kind});
      });
      this.db.prepare("UPDATE tasks SET status=?,updated_at=datetime('now') WHERE id=?").run(marks.length?'annotated':'skipped',id);
      this.db.exec('COMMIT');return {children,marks:marks.length,independent};
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  // Ordered actions from root to the immediate parent of task, including the selected mark.
  lineage(taskId){
    const actions=[];let task=this.getTask(taskId),steps=0;
    if(!task)throw Error('Task not found');
    while(task?.via_mark_id){
      if(++steps>24)throw Error('Route exceeds depth limit');
      const mark=this.getMark(task.via_mark_id),parent=this.getTask(task.parent_task_id);
      if(!mark||!parent)throw Error('Broken route');
      if(task.fresh_start){
        const capture=captureOf(parent);
        actions.push({mark,parent:{...parent,capture_json:JSON.stringify({...capture,requiresLive:false,rootMode:captureState(capture)==='BUY_MENU'?'menu':'base'})}});
        break;
      }
      actions.push({mark,parent});task=parent;
    }
    return actions.reverse();
  }
  // Parent tasks beyond an irreversible action require the ORIGINAL live context.
  liveParentRequired(taskId){return this.lineage(taskId).some(x=>markNeedsLive(captureOf(x.parent),x.mark));}
  retryUnreadRoots(){
    return this.db.prepare("UPDATE tasks SET status='queued',updated_at=datetime('now') WHERE parent_task_id IS NULL AND capture_file IS NULL AND status='failed' AND error LIKE 'GAME_NOT_READY%'").run().changes;
  }
  recoverLostSessions(){
    // Only at server startup, before any browser session exists. Never replay
    // an old random action; offer a separate, fresh root and preserve history.
    const affected=new Map();let blocked=0,roots=0;
    const rows=this.db.prepare("SELECT * FROM tasks WHERE status IN ('queued','ready','blocked','failed')").all();
    const seen=this.getSetting('lostSessionRecovery',{});
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const task of rows){
        if(task.replay_branch&&task.status==='queued'&&!task.capture_json)continue;
        const steps=this.lineage(task.id);
        const executed=task.status==='ready'||task.capture_json?steps:steps.slice(0,-1);
        const lost=captureNeedsLive(captureOf(task))||steps.some(s=>captureNeedsLive(captureOf(s.parent)))||
          executed.some(s=>markNeedsLive(captureOf(s.parent),s.mark));
        if(!lost)continue;
        this.fail(task.id,'blocked','LIVE_SESSION_LOST: La sesión anterior se cerró; se preparó una captura nueva sin repetir compras ni tiradas');
        blocked++;affected.set(task.game_id,Math.max(task.id,affected.get(task.game_id)||0));
      }
      for(const [gameId,lastLost] of affected){
        if((seen[gameId]||0)>=lastLost)continue;
        const available=this.db.prepare("SELECT id FROM tasks WHERE game_id=? AND parent_task_id IS NULL AND status IN ('queued','preparing','ready')").get(gameId);
        if(!available){this.db.prepare("INSERT INTO tasks(game_id,depth,status) VALUES(?,0,'queued')").run(gameId);roots++;}
        seen[gameId]=lastLost;
      }
      this.setSetting('lostSessionRecovery',seen);this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return {blocked,roots};
  }
  releaseFailedDescendants(parentId,reason){
    // Leaves the audit trail; does not silently re-run potentially irreversible DEMO operations.
    const descendants=this.db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM tasks WHERE parent_task_id=? UNION ALL
      SELECT t.id FROM tasks t JOIN sub ON t.parent_task_id=sub.id
    ) SELECT id FROM sub`).all(parentId);
    for(const {id} of descendants)this.db.prepare("UPDATE tasks SET status='blocked',error=? WHERE id=? AND status IN ('queued','preparing')").run(reason,id);
  }
}
