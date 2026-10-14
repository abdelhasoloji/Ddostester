// Runs inside the independently deployed lab-probe pod; fixed authorized endpoint.
const warmStart=performance.now(); const warmAt=new Date().toISOString();
const warmResponse=await fetch('http://lab-target:8080/health',{signal:AbortSignal.timeout(5000),redirect:'error'});await warmResponse.arrayBuffer();
const warmup={at:warmAt,status:warmResponse.status,latencyMs:performance.now()-warmStart};
const results=[];
for(let i=0;i<30;i++){
  const start=performance.now(); const at=new Date().toISOString();
  try{const r=await fetch('http://lab-target:8080/health',{signal:AbortSignal.timeout(1500),redirect:'error'});await r.arrayBuffer();results.push({at,status:r.status,latencyMs:performance.now()-start});}
  catch{results.push({at,status:0,latencyMs:performance.now()-start});}
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000-(performance.now()-start))));
}
console.log(JSON.stringify({scope:'independent-lab-probe-process',target:'http://lab-target:8080/health',warmup,results}));
