import path from 'node:path';
import {publicDemoUrl} from './providers.js';

export const DEFAULTS = Object.freeze({
  port: 4180, workers: 32, maxLive: 4, imageCacheMb: 512,
  sqliteCacheMb: 256, previewCount: 50, jpegQuality: 65,
  viewportWidth: 1280, viewportHeight: 720,
});
export function numberEnv(name, fallback, min, max) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw Error(`${name} must be ${min}..${max}`);
  return n;
}
export function loadConfig() {
  const dataDir = path.resolve(process.env.DATA_DIR || './data');
  return {
    host: '127.0.0.1',
    port: numberEnv('PORT',DEFAULTS.port,1024,65535),
    dataDir,
    workers: numberEnv('WORKERS',DEFAULTS.workers,1,160),
    maxLive: numberEnv('MAX_LIVE',DEFAULTS.maxLive,1,12),
    imageCacheMb: numberEnv('IMAGE_CACHE_MB',DEFAULTS.imageCacheMb,16,16384),
    sqliteCacheMb: numberEnv('SQLITE_CACHE_MB',DEFAULTS.sqliteCacheMb,8,8192),
    previewCount: numberEnv('PRELOAD_COUNT',DEFAULTS.previewCount,1,250),
    readyGamesTarget: numberEnv('READY_GAMES_TARGET',100,1,100),
    jpegQuality: numberEnv('JPEG_QUALITY',DEFAULTS.jpegQuality,35,90),
    headless: process.env.HEADLESS === '1',
    gpuMode: process.env.GPU_MODE || 'auto',
    viewportWidth: numberEnv('VIEWPORT_WIDTH',DEFAULTS.viewportWidth,800,3840),
    viewportHeight: numberEnv('VIEWPORT_HEIGHT',DEFAULTS.viewportHeight,500,2160),
    saveHar: process.env.SAVE_HAR === '1',
    visualTolerance: Number.isFinite(Number(process.env.VISUAL_TOLERANCE)) ? Math.min(0.5,Math.max(0.05,Number(process.env.VISUAL_TOLERANCE||0.22))) : 0.22,
  };
}
// A narrow, explicit allowlist prevents accidentally operating on real-money sessions.
// Future providers must implement their own DEMO-only adapter and URL validation.
export function demoUrl(raw){return publicDemoUrl(raw);}
export function gameSlug(raw){const u=new URL(raw);return u.searchParams.get('game')||u.searchParams.get('g')||u.pathname.match(/\/play\/([^/]+)\/FUN\/?$/)?.[1]||u.pathname.split('/').filter(Boolean).at(-1)||u.hostname;}
export function clamp(n,min,max){return Math.max(min,Math.min(max,n));}
export function normalizeMarks(marks) {
  if (!Array.isArray(marks) || marks.length > 40) throw Error('Use an array of up to 40 click marks');
  return marks.map((m,i)=>{
    if (!m || !Number.isFinite(m.x) || !Number.isFinite(m.y) || m.x<0 || m.x>1 || m.y<0 || m.y>1) throw Error(`Invalid normalized coordinate at mark ${i+1}`);
    const kind=String(m.kind||'navigate');
    if(!['click','navigate','buy','antebet','antebet_toggle','confirm','pick','continue','spin','other'].includes(kind))throw Error(`Invalid action kind: ${kind}`);
    return {x:Math.round(m.x*1000000)/1000000,y:Math.round(m.y*1000000)/1000000,kind,label:String(m.label||'').trim().slice(0,80)};
  });
}
export function isIrreversible(kind){return ['click','buy','antebet','antebet_toggle','confirm','pick','continue','spin'].includes(kind);}
