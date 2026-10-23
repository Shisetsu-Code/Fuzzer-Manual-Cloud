import {spawn} from 'node:child_process';
export async function launchFleet(clientId,{workers=4,gamesPerWorker=8,minutes=60}={}){
 if(!Number.isInteger(workers)||workers<1||workers>20||!Number.isInteger(gamesPerWorker)||gamesPerWorker<1||gamesPerWorker>8||!Number.isInteger(minutes)||minutes<5||minutes>300)throw Error('Workers: 1–20, juegos: 1–8, minutos: 5–300');
 const repo=process.env.FLEET_REPO||'Shisetsu-Code/Fuzzer-Manual-Cloud';
 if(!/^[\w.-]+\/[\w.-]+$/.test(repo))throw Error('Repositorio inválido');
 await new Promise((resolve,reject)=>{
  const child=spawn('gh',['workflow','run','manual-workers.yml','--repo',repo,'--ref','main','--json'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let error='';child.stderr.on('data',b=>{error+=b;});child.on('error',()=>reject(Error('GitHub CLI no está disponible; instalá gh e iniciá sesión')));
  child.on('close',code=>code===0?resolve():reject(Error('No se pudo iniciar la flota de GitHub. Revisá gh auth status. '+error.slice(0,150))));
  child.stdin.end(JSON.stringify({client_id:clientId,workers:String(workers),games_per_worker:String(gamesPerWorker),duration_minutes:String(minutes),confirm_adult:'true'}));
 });
 return {ok:true,workers,gamesPerWorker,url:`https://github.com/${repo}/actions/workflows/manual-workers.yml`};
}
