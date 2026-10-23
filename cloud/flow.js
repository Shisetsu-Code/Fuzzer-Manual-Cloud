export function phaseOf(capture){
 const controls=(capture?.controls||[]).filter(c=>c.hit),paths=controls.map(c=>c.path||'');
 if(paths.some(p=>/FSWindows\/FSResult\/ButtonContinue|FreeSpins\/Banner\/.*\/FreeSpins\/Result\/ButtonContinue/.test(p)))return 'result';
 if(paths.some(p=>/FSWindows\/FSStart\/ButtonContinue|FreeSpins\/Banner\/.*\/FreeSpins\/Start\/ButtonContinue/.test(p)))return 'start';
 if(paths.some(p=>/ConfirmWindow\/Buttons\/Button_Yes|BuyWindow\/.*Buttons\/ButtonYes|ConfirmPurchaseWindow/.test(p)))return 'confirmation';
 if(paths.some(p=>/FreeSpins\/Bonus\/Content\/Buttons\/B_\d/.test(p)))return 'choice';
 if(paths.some(p=>/StopSpin_Button/.test(p)))return 'active';
 if(['BASE','BUY_MENU'].includes(capture?.state))return 'idle';
 return 'unknown';
}
export function observeFlow(flow,capture){
 const phase=phaseOf(capture);
 if(phase==='result')flow.resultSeen=true;
 if(phase==='start'||phase==='active'||phase==='choice')flow.roundSeen=true;
 if(flow.purchasePending&&flow.resultSeen&&phase==='idle')flow.completed=true;
 return {version:1,phase:flow.completed?'completed':phase,purchasePending:!!flow.purchasePending,terminalPurchase:!!flow.completed,proof:flow.completed?'observed-result-then-idle':null};
}
