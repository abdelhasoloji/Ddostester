"""Deploy three bounded, heartbeat-only observers into the existing owned VPS lab."""
import argparse
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['prepare', 'create', 'addresses', 'install', 'verify'])
parser.add_argument('directory')
args = parser.parse_args()
root = Path(args.directory).resolve()
if not root.is_dir() or root.stat().st_mode & 0o077:
    raise RuntimeError('Use an existing owner-private operation directory')
os.umask(0o077)
node = 'k3d-ddostester-linux-lab-server-0'
namespace = 'ddostester-lab'
operation = 'fleet-observers-20261014-01'
image = 'docker.io/library/ddostester-lab-control@sha256:5a50d8220442d1e0134f61559484e03b35288e0d8e8e5f8e3cba6ab25b6321be'

def command(arguments, content=None):
    result = subprocess.run(arguments, input=content, text=True, capture_output=True, timeout=60)
    if result.returncode:
        raise RuntimeError(result.stderr[-3000:])
    return result.stdout

def kubectl(*arguments, content=None):
    return command(['docker', 'exec', '-i', node, 'kubectl', *arguments], content)

def save(name, value):
    path = root / name
    with path.open('x') as handle:
        json.dump(value, handle, indent=2)
    path.chmod(0o600)

identity = command(['docker', 'inspect', node, '--format', '{{.Id}}']).strip()
if identity != '311ee158d9e5a169c8dba8f5fc0caa3e56089e960c6a8ea29f5f7902b1fc8c7f':
    raise RuntimeError('Lab node identity mismatch')
labels = {'app': 'fleet-observer', 'ddostester.operation': operation, 'app.kubernetes.io/part-of': 'ddostester-lab'}
if args.action == 'prepare':
    if (root / 'agent-ca.key').exists():
        raise RuntimeError('Existing CA is preserved')
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '30', '-subj', '/CN=Ddostester VPS lab fleet CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', str(root/'agent-ca.key'), '-out', str(root/'agent-ca.crt')])
    extension = root/'client.ext'
    extension.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=clientAuth\n')
    for index in range(1, 4):
        name = f'lab-iot-{index:02}'
        command(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={name}', '-keyout', str(root/f'{name}.key'), '-out', str(root/f'{name}.csr')])
        command(['openssl', 'x509', '-req', '-in', str(root/f'{name}.csr'), '-CA', str(root/'agent-ca.crt'), '-CAkey', str(root/'agent-ca.key'), '-set_serial', '0x'+secrets.token_hex(16), '-days', '14', '-sha256', '-extfile', str(extension), '-out', str(root/f'{name}.crt')])
        command(['openssl', 'verify', '-purpose', 'sslclient', '-CAfile', str(root/'agent-ca.crt'), str(root/f'{name}.crt')])
    bundle = [{'apiVersion':'v1','kind':'ConfigMap','metadata':{'name':operation,'namespace':namespace,'labels':labels},'data':{name:(root/name).read_text() for name in ['heartbeat-agent.mjs','kubernetes-observer.mjs']}}]
    bundle.append({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':operation,'namespace':namespace,'labels':labels},'spec':{'podSelector':{'matchLabels':{'app':'fleet-observer','ddostester.operation':operation}},'policyTypes':['Ingress','Egress'],'ingress':[],'egress':[{'to':[{'ipBlock':{'cidr':'31.31.74.228/32'}}],'ports':[{'protocol':'TCP','port':443}]}]}})
    for index in range(1,4):
        name=f'lab-iot-{index:02}'
        security={'allowPrivilegeEscalation':False,'readOnlyRootFilesystem':True,'capabilities':{'drop':['ALL']}}
        common={'image':image,'imagePullPolicy':'Never','securityContext':security,'resources':{'requests':{'cpu':'25m','memory':'64Mi'},'limits':{'cpu':'100m','memory':'128Mi'}},'env':[{'name':'POD_IP','valueFrom':{'fieldRef':{'fieldPath':'status.podIP'}}}],'volumeMounts':[{'name':'work','mountPath':'/work'},{'name':'source','mountPath':'/observer','readOnly':True}]}
        init={**common,'name':'prepare','command':['node','/observer/kubernetes-observer.mjs','prepare'],'volumeMounts':common['volumeMounts']+[{'name':'enrollment','mountPath':'/incoming','readOnly':True}]}
        agent={**common,'name':'observer','command':['node','/observer/kubernetes-observer.mjs'],'env':common['env']+[{'name':'FLEET_AGENT_TLS_CA','value':'/work/server-ca.crt'},{'name':'FLEET_AGENT_TLS_CERT','value':'/work/client.crt'},{'name':'FLEET_AGENT_TLS_KEY','value':'/work/client.key'}],'readinessProbe':{'exec':{'command':['node','-e',"const s=require('fs').statSync('/work/last-accepted');if(Date.now()-s.mtimeMs>15000)process.exit(1)"]},'initialDelaySeconds':2,'periodSeconds':5,'timeoutSeconds':2}}
        bundle.append({'apiVersion':'v1','kind':'Pod','metadata':{'name':name,'namespace':namespace,'labels':labels},'spec':{'restartPolicy':'Never','activeDeadlineSeconds':86460,'automountServiceAccountToken':False,'securityContext':{'runAsNonRoot':True,'runAsUser':1000,'runAsGroup':1000,'fsGroup':1000,'seccompProfile':{'type':'RuntimeDefault'}},'initContainers':[init],'containers':[agent],'volumes':[{'name':'work','emptyDir':{'sizeLimit':'16Mi'}},{'name':'source','configMap':{'name':operation}},{'name':'enrollment','secret':{'secretName':name+'-enrollment','optional':True,'defaultMode':0o440}}]}})
    save('public-manifests.json',{'apiVersion':'v1','kind':'List','items':bundle})
    print(json.dumps({'prepared':True,'agents':3,'privateCaOnLabOnly':True}))
elif args.action == 'create':
    content=(root/'public-manifests.json').read_text()
    kubectl('create','--dry-run=server','-f','-',content=content)
    result=kubectl('create','-f','-','-o','json',content=content)
    decoder=json.JSONDecoder()
    created=[]
    while result.strip():
        result=result.lstrip()
        item,end=decoder.raw_decode(result)
        created.append(item)
        result=result[end:]
    save('created-resources.json',{'apiVersion':'v1','kind':'List','items':created})
    print(json.dumps({'created':True,'agents':3}))
elif args.action == 'addresses':
    for attempt in range(60):
        pods=json.loads(kubectl('get','pods','-n',namespace,'-l','ddostester.operation='+operation,'-o','json'))['items']
        if len(pods)==3 and all(p.get('status',{}).get('podIP') for p in pods):
            addresses=[{'name':p['metadata']['name'],'uid':p['metadata']['uid'],'privateIp':p['status']['podIP']} for p in pods]
            if len({p['privateIp'] for p in addresses})!=3 or any(not p['privateIp'].startswith('10.247.') for p in addresses):
                raise RuntimeError('Expected three distinct owned lab pod IPs')
            save('addresses.json',addresses)
            print(json.dumps(addresses))
            break
        time.sleep(1)
    else:
        raise RuntimeError('Pod addresses not allocated')
elif args.action == 'install':
    enrollments=json.loads((root/'enrollments.json').read_text())
    addresses=json.loads((root/'addresses.json').read_text())
    resources=[]
    for enrollment in enrollments:
        name=enrollment['agentId']
        match=next(p for p in addresses if p['name']==name)
        current=json.loads(kubectl('get','pod',name,'-n',namespace,'-o','json'))
        if current['metadata']['uid']!=match['uid'] or enrollment['privateIp']!=match['privateIp']:
            raise RuntimeError('Pod/enrollment identity mismatch')
        data={'enrollment.json':json.dumps(enrollment),'server-ca.crt':(root/'server-ca.crt').read_text(),'client.crt':(root/f'{name}.crt').read_text(),'client.key':(root/f'{name}.key').read_text()}
        resources.append({'apiVersion':'v1','kind':'Secret','metadata':{'name':name+'-enrollment','namespace':namespace,'labels':labels},'type':'Opaque','data':{key:base64.b64encode(value.encode()).decode() for key,value in data.items()}})
    kubectl('create','-f','-',content=json.dumps({'apiVersion':'v1','kind':'List','items':resources}))
    (root/'enrollments.json').unlink()
    print(json.dumps({'enrollmentsInstalled':3,'uploadRemoved':True}))
else:
    kubectl('wait','--for=condition=Ready','pod','-n',namespace,'-l','ddostester.operation='+operation,'--timeout=50s')
    pods=json.loads(kubectl('get','pods','-n',namespace,'-l','ddostester.operation='+operation,'-o','json'))
    save('ready-pods.json',pods)
    for pod in pods['items']:
        log=kubectl('logs',pod['metadata']['name'],'-n',namespace,'-c','observer','--tail=5')
        (root/(pod['metadata']['name']+'.log')).write_text(log)
    print(json.dumps({'ready':3,'heartbeatOnly':True}))
