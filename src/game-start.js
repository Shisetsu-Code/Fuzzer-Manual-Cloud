import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import {randomUUID} from 'node:crypto';
const run=promisify(execFile),waiters=[];let busy=0;
export async function readGameText(imagePath){
  if(process.platform!=='win32')throw Error('Local screen text recognition is unavailable');
  if(busy>=3)await new Promise(resolve=>waiters.push(resolve));else busy++;
  try{
    const script=fileURLToPath(new URL('../scripts/read-game-text.ps1',import.meta.url));
    const recognize=async file=>{const {stdout}=await run('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-ImagePath',path.resolve(file)],{windowsHide:true,timeout:12000,maxBuffer:512*1024,encoding:'utf8'});return JSON.parse(stdout.replace(/^\uFEFF/,''));};
    const result=await recognize(imagePath);
    if(gameStartEvidence(result).state==='UNKNOWN'){
      const enlarged=path.resolve(imagePath)+'.'+randomUUID()+'.png';
      try{await sharp(imagePath).resize({width:2400}).sharpen().png().toFile(enlarged);const extra=await recognize(enlarged);result.lines.push(...extra.lines);}
      finally{await fs.rm(enlarged,{force:true}).catch(()=>{});}
    }
    // Decorative white/gold intro lettering needs stronger contrast than the HUD.
    if(gameStartEvidence(result).state==='UNKNOWN'&&/SYMBOLS PAY|GAME FEATURES|WELCOME|RANDOM MULTIPLIER/i.test(result.lines.map(l=>l.text).join(' '))){
      const meta=await sharp(imagePath).metadata();
      const rect={left:Math.floor(meta.width*.14),top:Math.floor(meta.height*.75),width:Math.floor(meta.width*.72),height:meta.height-Math.floor(meta.height*.75)};
      const {data,info}=await sharp(imagePath).extract(rect).toColourspace('srgb').removeAlpha().raw().toBuffer({resolveWithObject:true});
      const mask=Buffer.alloc(info.width*info.height);
      for(let i=0;i<mask.length;i++){const r=data[i*3],g=data[i*3+1],b=data[i*3+2];mask[i]=Math.min(r,g,b)>160&&Math.max(r,g,b)-Math.min(r,g,b)<75?0:255;}
      const file=path.resolve(imagePath)+'.'+randomUUID()+'.png';
      try{
        await sharp(mask,{raw:{width:info.width,height:info.height,channels:1}}).resize({width:Math.min(2500,info.width*2)}).png().toFile(file);
        const extra=await recognize(file);
        result.lines.push(...extra.lines.map(l=>({...l,x:(rect.left+l.x*rect.width)/meta.width,y:(rect.top+l.y*rect.height)/meta.height,w:l.w*rect.width/meta.width,h:l.h*rect.height/meta.height})));
      }finally{await fs.rm(file,{force:true}).catch(()=>{});}
    }
    return result;
  }finally{const next=waiters.shift();if(next)next();else busy--;}
}
export function gameStartEvidence(result,{provider=null}={}){
  const lines=(result?.lines||[]).map(line=>({...line,text:String(line.text||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim().replace(/^[—–_-]+|[.!…—–_-]+$/g,'').toUpperCase()}));
  const text=lines.map(line=>line.text).join('\n');
  if(/ACCESS DENIED|YOU DON.T HAVE PERMISSION TO ACCESS/.test(text))return {state:'BLOCKED',issue:'ACCESS_DENIED'};
  if(/CONNECTION (?:LOST|IOST) TO WALLET|FAILED TO CONNECT TO (?:THE )?SERVER|GAME (?:IS )?UNAVAILABLE/.test(text))return {state:'BLOCKED',issue:'DEMO_CONNECTION_FAILED'};
  if(/\bLOADING\b|\bCARGANDO\b|PLEASE WAIT|CONNECTING|INITIALIZING/.test(text))return {state:'LOADING'};
  if(/BET OPTIONS/.test(text)&&/TOTAL BET/.test(text)&&!/BUY|PURCHASE|BONUS COST/.test(text)){
    const confirm=lines.find(l=>l.text==='CONFIRM'&&Number.isFinite(l.x)&&Number.isFinite(l.y)&&l.w>0&&l.h>0);
    if(confirm)return {state:'SETUP',start:confirm};
  }
  const start=lines.find(line=>(/^(?:(?:CLICK|TAP|TOUCH|PRESS)(?: ANYWHERE| HERE| THE SCREEN)? (?:TO|AND) (?:START|BEGIN|CONTINUE|PLAY)|START GAME|PLAY GAME|CONTINUE|INICIAR JUEGO|COMENZAR|CONTINUAR|TOCA PARA (?:EMPEZAR|COMENZAR)|HAZ CLIC PARA (?:EMPEZAR|COMENZAR))$/.test(line.text)||/^[A-Z]{0,2}(?:CLICK|TAP|TOUCH|PRESS)(?:ANYWHERE|HERE|THESCREEN)?(?:TO|AND)(?:START|BEGIN|CONTINUE|PLAY)$/.test(line.text.replace(/[^A-Z]/g,'')))&&Number.isFinite(line.x)&&Number.isFinite(line.y)&&line.w>0&&line.h>0);
  if(start)return {state:'INTRO',start};
  const hud=(/\b(?:BALANCE|CASH|CREDITS?|CREDITOS?|SALDO|GUTHABEN|SOLDE|FREEPLAY|DEMO PLAY)\b/.test(text)||/F?REEP[LIT]AY/.test(text.replace(/\s/g,'')))&&/\b(?:BET|STAKE|APUESTA|MISE|EINSATZ)\b/.test(text);
  if(!hud&&!/BUY BONUS|PURCHASE|CONFIRM/.test(text)&&(/SYMBOLS PAY|GAME FEATURES|WELCOME|RANDOM MULTIPLIER|VOLATILIDAD|VOLATILITY/.test(text)||provider==='rubyplay'&&/TO ACTIVATE|FLOATING WILD|FREE SPINS|MULTIPLIER|WILD REELS/.test(text))){
    const short=lines.find(l=>/^(?:START|PLAY|JUGAR)$/.test(l.text)&&Number.isFinite(l.x)&&Number.isFinite(l.y)&&l.w>0&&l.h>0);
    if(short)return {state:'INTRO',start:short};
  }
  if(hud&&/\d/.test(text))return {state:'RUNNING'};
  if(provider==='thunderkick'&&/BET\s*\+/.test(text)&&/\bAUTO\b/.test(text)&&/\d+[.,]\d{2}/.test(text)&&!/FEATURE|ANYWHERE|TO START/.test(text))return {state:'RUNNING'};
  if(provider==='redtiger'&&!/\bBET\b|BALANCE|CREDITS|BUY BONUS|PURCHASE/.test(text)&&/WIN|PAYS|WAYS|OVER/.test(text)&&/\d/.test(text)){
    const play=lines.find(l=>l.text==='PLAY'&&Number.isFinite(l.x)&&Number.isFinite(l.y)&&l.w>0&&l.h>0);
    if(play)return {state:'INTRO',start:play};
  }
  if(provider==='playtech'&&/\bLINES\b/.test(text)&&/\bWIN\b/.test(text)&&/TOTAL BET/.test(text)&&/\d/.test(text)&&!/GAME FEATURES|BUY BONUS|PURCHASE|CONFIRM/.test(text))return {state:'RUNNING'};
  if(provider==='playngo'&&/PRESS SPIN TO BEGIN/.test(text)&&/\d/.test(text))return {state:'RUNNING'};
  if(provider==='elk'&&!/\bBET\b|BALANCE|PURCHASE/.test(text)){
    const sound=lines.find(l=>/SOUND ON\s*\/\s*OFF/.test(l.text)&&l.y>.4&&l.y<.8);
    if(sound)return {state:'INTRO',start:{text:'ELK_SOUND_ENTRY',x:.46,y:Math.max(.1,sound.y-.22),w:.08,h:.12}};
  }
  return {state:'UNKNOWN'};
}
