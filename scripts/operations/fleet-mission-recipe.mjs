// Operator-owned end-to-end lab recipe. Creates no account or persistent session.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const [release, directory] = process.argv.slice(2);
for (const line of (await readFile('/etc/ddostester.env','utf8')).split('\n')) {
  if (!line.trim() || line.trimStart().startsWith('#')) continue;
  const i=line.indexOf('='); if(i<1) throw new Error('Invalid protected environment');
  process.env[line.slice(0,i).trim()] = line.slice(i+1).trim().replace(/^(["'])(.*)\1$/, '$2');
}
const { createStore }=await import(pathToFileURL(release+'/backend/dist/store/index.js'));
const { signJwt }=await import(pathToFileURL(release+'/backend/dist/auth/jwt.js'));
const store=await createStore();
try {
  const owner=await store.getUser('abdelha@wedos');
  if(owner?.role!=='admin' || owner.status==='disabled' || owner.mustChangePassword) throw new Error('Owner is not ready');
  const token=signJwt({sub:owner.email,role:owner.role,ver:owner.tokenVersion??0}, process.env.AUTH_JWT_SECRET,180);
  await store.saveAudit({id:randomUUID(),at:new Date().toISOString(),actor:'operations:lab-fleet-recipe',action:'store.mutate',detail:'fleet.recipe ephemeral owner session TTL=180s; dedicated private lab-target only; no account mutation'});
  const call=async(path,body)=>{
    const response=await fetch('http://127.0.0.1:8080'+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const value=await response.json(); if(!response.ok) throw new Error(JSON.stringify({status:response.status,value}));return value;
  };
  const devices=(await call('/api/fleet/devices')).devices.filter(d=>/^lab-iot-0[1-3]$/.test(d.agentId));
  if(devices.length!==3 || devices.some(d=>d.connection!=='online' || d.agentVersion!=='fleet-mission-agent/v1')) throw new Error('Three mission-ready devices required');
  const results=[];
  for(const interrupted of [false,true]) {
    const durationSec=interrupted?30:20;
    const mission=await call('/api/fleet/missions',{deviceIds:devices.map(d=>d.id),maxRps:3,concurrency:3,durationSec,confirmed:true});
    console.log(JSON.stringify({event:'recipe.launch',id:mission.id,interrupted}));
    const started=Date.now(); let sentStop=false; let final;
    while(Date.now()-started<(durationSec+10)*1000) {
      if(interrupted && !sentStop && Date.now()-started>=6000){ await call('/api/fleet/missions/'+mission.id+'/stop',{});sentStop=true;console.log(JSON.stringify({event:'recipe.stop',id:mission.id})); }
      const state=(await call('/api/fleet/missions')).missions.find(m=>m.id===mission.id);
      if(state?.snapshot?.state==='SETTLED'){final=state;break;}
      await new Promise(r=>setTimeout(r,1000));
    }
    if(!final || final.snapshot.shards.length!==3 || final.snapshot.shards.some(s=>s.state!==(interrupted?'STOPPED':'SUCCEEDED') || !s.result?.generator || s.result.generator.successful<1 || s.result.generator.failed!==0)) throw new Error('Recipe incomplete: '+JSON.stringify(final));
    results.push({interrupted,mission:final});
    console.log(JSON.stringify({event:'recipe.settled',id:mission.id,states:final.snapshot.shards.map(s=>s.state)}));
    const reserved=mission.deadline+2500-Date.now();if(reserved>0)await new Promise(r=>setTimeout(r,reserved));
  }
  await writeFile(directory+'/recipe-results.json',JSON.stringify({target:'http://lab-target:8080/',devices:devices.map(d=>({id:d.id,agentId:d.agentId,privateIp:d.privateIp})),results},null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({recipePassed:true,missions:2,agents:3,accountsUnchanged:true}));
}finally{await store.close();}
