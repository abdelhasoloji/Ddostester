// Disposable loopback-only campaign journey. No production storage or credentials.
import {createServer} from 'node:http';
import {buildApp} from '../../../backend/dist/app.js';
import {MemoryStore} from '../../../backend/dist/store/memory.js';
import {initAuth} from '../../../backend/dist/auth/guard.js';
const store=new MemoryStore();
let requests=0;
const target=createServer((req,res)=>{res.statusCode=req.url==='/load'&&++requests%25===0?503:200;res.end('local qualification');});
await new Promise(resolve=>target.listen(18120,'127.0.0.1',resolve));
await store.saveCampaign({id:'graphs-local',name:'Local graph qualification',target:'http://127.0.0.1:18120/load',probeUrl:'http://127.0.0.1:18120/health',probeUrls:['http://127.0.0.1:18120/secondary'],vector:'http-get',maxRps:20,concurrency:2,maxDurationSec:20,createdBy:'local',authorized:true,createdAt:new Date().toISOString(),status:'APPROVED',approvedBy:'reviewer',approvalExpiresAt:new Date(Date.now()+86400000).toISOString()});
const {app}=await buildApp({store,auth:initAuth({USER_MODE:'team'}),allowedTargets:['127.0.0.1'],logger:false,serveStatic:true});
app.addHook('onRequest',async(req,reply)=>{if(!['GET','HEAD','OPTIONS'].includes(req.method)&&!(req.method==='POST'&&['/api/campaigns/graphs-local/execute','/api/campaigns/graphs-local/kill'].includes(req.url)))return reply.code(403).send({error:'Only the dedicated loopback campaign is executable.'});});
await app.listen({host:'127.0.0.1',port:18110});
console.log('Local campaign ready: http://127.0.0.1:18110/theater?run=graphs-local');
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();target.close();process.exit(0);});
