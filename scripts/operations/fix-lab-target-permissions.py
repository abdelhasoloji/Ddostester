"""Restore readable benchmark content on the dedicated owned target, without privilege escalation."""
import json
from pathlib import Path
import subprocess
import sys
root=Path(sys.argv[1]).resolve()
if not root.is_dir() or root.stat().st_mode & 0o077: raise RuntimeError('Private operation directory required')
node='k3d-ddostester-linux-lab-server-0'
ns='ddostester-lab'
def kube(*argv,content=None):
    p=subprocess.run(['docker','exec','-i',node,'kubectl','-n',ns,*argv],input=content,text=True,capture_output=True,timeout=60)
    if p.returncode:raise RuntimeError(p.stderr[-2000:])
    return p.stdout
deployment=json.loads(kube('get','deployment','lab-target','-o','json'))
if deployment['metadata']['uid']!='b3dff26f-00a4-4756-9959-e339fc97e22a':raise RuntimeError('Target identity mismatch')
with (root/'target-deployment-before.json').open('x') as f:json.dump(deployment,f)
receipts=kube('exec','deployment/lab-target','-c','target','--','tail','-n','1000','/var/log/lab/requests.jsonl')
with (root/'first-target-receipts.jsonl').open('x') as f:f.write(receipts)
files=sorted((root/'www').rglob('*'))
data={};items=[]
for p in files:
    if not p.is_file():continue
    relative=p.relative_to(root/'www').as_posix(); key=relative.replace('/','__')
    data[key]=p.read_text();items.append({'key':key,'path':relative})
if 'index.html' not in data or 'api__echo.php' not in data or sum(len(x) for x in data.values())>65536:raise RuntimeError('Unexpected benchmark content')
config={'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':'lab-target-web-readable-20261014-01','namespace':ns},'data':data}
kube('create','-f','-',content=json.dumps(config))
spec=deployment['spec']['template']['spec']
spec['volumes'].append({'name':'readable-benchmark','configMap':{'name':config['metadata']['name'],'defaultMode':0o644,'items':items}})
target=next(c for c in spec['containers'] if c['name']=='target')
target['volumeMounts'].append({'name':'readable-benchmark','mountPath':'/var/www/benchmark','readOnly':True})
deployment.pop('status',None)
kube('replace','-f','-',content=json.dumps(deployment))
with (root/'target-readable-configmap.json').open('x') as f:json.dump(config,f)
print(json.dumps({'targetPatched':True,'nonRootRetained':True,'readOnlyContent':True,'sourceFiles':len(data)}))
