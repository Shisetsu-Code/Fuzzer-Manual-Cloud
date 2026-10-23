import {isIrreversible} from './config.js';

export function captureOf(task){return task?.capture_json?JSON.parse(task.capture_json):{};}
export function controlForMark(capture,mark){
  return (capture?.controls||[]).filter(c=>c.hit&&mark.x>=c.hit.x&&mark.x<=c.hit.x+c.hit.w&&mark.y>=c.hit.y&&mark.y<=c.hit.y+c.hit.h)
    .sort((a,b)=>a.hit.w*a.hit.h-b.hit.w*b.hit.h)[0];
}
export function captureState(capture){
  const paths=(capture?.controls||[]).filter(c=>c.hit).map(c=>c.path);
  if(paths.some(p=>/ConfirmPurchaseWindow|FSPurchaseWindow\/content\/Buttons|BuyWindow\/.*Buttons\/ButtonYes/i.test(p)))return 'CONFIRM';
  if(paths.some(p=>/FSWindows\/.*ButtonContinue/i.test(p)))return 'BONUS';
  if(!['BONUS','INTRO'].includes(capture?.state)&&paths.some(p=>/PurchaseWindow\/content\/Options\/|FreeSpinsPurchase\/Content\/Options\//i.test(p)))return 'BUY_MENU';
  return capture?.state||'UNKNOWN';
}
export function classifyMark(capture,mark){
  // The operator's right-click denotes a compound antebet test, not a purchase.
  if(['antebet','sequence','ordered'].includes(mark.kind))return {...mark};
  const control=controlForMark(capture,mark);
  const p=control?.path||'';
  let kind=mark.kind||'navigate';
  if(/FeaturePurchase\/MainButton|BuyFeature\/MainButton/i.test(p))kind='navigate';
  else if(/AnteBet|BetLevel/i.test(p))kind='antebet_toggle';
  else if(/ConfirmPurchaseWindow\/.*AcceptButton|FSPurchaseWindow\/.*(?:Accept|Confirm|Yes)|BuyWindow\/.*Buttons\/ButtonYes/i.test(p))kind='confirm';
  else if(/PurchaseWindow\/content\/Options\/|BuyFeature\/.*BuyButtons\/.*\/Button(?:\/|$)|FreeSpinsPurchase\/Content\/Options\/.*\/OptionButton/i.test(p))kind='buy';
  else if(/StartSpin_Button/i.test(p)||(control?.handlers||[]).some(h=>/Pressed_Spin$/i.test(h)))kind='spin';
  else if(/FreeSpins\/.*(?:ButtonContinue|ContinueButton|ButtonCollect)|StageResultFreeSpin\/.*(?:Button|Collider)|FSWindows\/.*ButtonContinue/i.test(p))kind='continue';
  return {...mark,kind};
}
export function captureNeedsLive(capture){return Boolean(capture?.requiresLive||(capture?.manualReview&&!capture?.replayableRoot)||captureState(capture)==='BONUS');}
export function captureCanBranch(capture){return !capture?.manualReview&&['BASE','BUY_MENU'].includes(captureState(capture))&&(!capture?.antebet||capture.antebet.phase==='done');}
export function markNeedsLive(capture,mark){return captureNeedsLive(capture)||isIrreversible(classifyMark(capture,mark).kind);}
export function gameDecisionReady(view){
  if(!view?.scan?.supported||view.scan.loading!==false||!['BASE','BUY_MENU','CONFIRM','BONUS'].includes(captureState(view)))return false;
  const controls=view.controls.filter(c=>c.hit&&c.hit.w>0&&c.hit.h>0);
  if(!controls.length)return false;
  const spinning=controls.some(c=>/StopSpin_Button/i.test(c.path));
  const decision=controls.some(c=>/ButtonContinue|ContinueButton|ButtonCollect|StageResultFreeSpin|ConfirmPurchaseWindow|BuyWindow\/.*ButtonYes/i.test(c.path));
  return !spinning||decision;
}
