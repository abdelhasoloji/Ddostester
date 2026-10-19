// Local presentation fixture. Sequence state is illustrative; execution is disabled.
import {buildApp} from '../../../backend/dist/app.js';
import {MemoryStore} from '../../../backend/dist/store/memory.js';
import {initAuth} from '../../../backend/dist/auth/guard.js';
import {createCampaign} from '../../../backend/dist/modules/campaigns/service.js';
const store = new MemoryStore();
await store.setLimits({maxRps:20,maxConcurrency:5,maxDurationSec:15});
const campaign = createCampaign({name:'Local UI fixture — next step',createdBy:'fixture',target:'http://127.0.0.1/',probeUrl:'http://127.0.0.1/',vector:'http-get',maxRps:5,concurrency:2,maxDurationSec:3,authorized:true},['127.0.0.1']);
await store.saveCampaign({...campaign,id:'prior-ui',status:'COMPLETED',suiteId:'review-ui',suiteName:'Local UI fixture — no generation',suiteOrder:0});
await store.saveCampaign({...campaign,id:'next-ui',status:'APPROVED',suiteId:'review-ui',suiteName:'Local UI fixture — no generation',suiteOrder:1});
const {app} = await buildApp({store,auth:initAuth({USER_MODE:'team'}),logger:false,serveStatic:true,allowedTargets:['127.0.0.1']});
app.addHook('onRequest',async (req,reply) => {
  if(req.url === '/api/suites/sequences') return reply.send({sequences:{'review-ui':{paused:true,pauseBetweenSteps:true,started:1,total:2}}});
  if(!['GET','HEAD','OPTIONS'].includes(req.method) && !/^\/api\/campaigns\/next-ui\/parameters$/.test(req.url))
    return reply.code(403).send({error:'Presentation fixture: execution disabled.'});
});
await app.listen({host:'127.0.0.1',port:18110});
console.log('Local UI-only fixture ready; execution disabled.');
for(const signal of ['SIGINT','SIGTERM']) process.on(signal, async () => {await app.close();process.exit(0);});
