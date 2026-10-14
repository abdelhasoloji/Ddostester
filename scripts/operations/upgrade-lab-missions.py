"""Explicit operator upgrade of the three existing lab observers; no extra fleet."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
parser = argparse.ArgumentParser()
parser.add_argument('action', choices=['prepare', 'replace', 'addresses'])
parser.add_argument('directory')
args = parser.parse_args()
root = Path(args.directory).resolve()
old = Path('/var/lib/ddostester-fleet-observers-20261014-01')
if not root.is_dir() or root.stat().st_mode & 0o077:
    raise RuntimeError('Private operation directory required')
os.umask(0o077)
node = 'k3d-ddostester-linux-lab-server-0'
ns = 'ddostester-lab'
def command(argv, content=None):
    p = subprocess.run(argv, input=content, text=True, capture_output=True, timeout=60)
    if p.returncode:
        raise RuntimeError(p.stderr[-2000:])
    return p.stdout
def kube(*argv, content=None):
    return command(['docker','exec','-i',node,'kubectl',*argv],content)
def save(name, data):
    with (root/name).open('x') as f:
        json.dump(data,f,indent=2)
if command(['docker','inspect',node,'--format','{{.Id}}']).strip() != '311ee158d9e5a169c8dba8f5fc0caa3e56089e960c6a8ea29f5f7902b1fc8c7f':
    raise RuntimeError('Lab node identity changed')
if args.action == 'prepare':
    bundle = json.loads((old/'public-manifests.json').read_text())
    pods = json.loads(kube('get','pods','-n',ns,'-l','ddostester.operation=fleet-observers-20261014-01','-o','json'))['items']
    if sorted(p['metadata']['name'] for p in pods) != ['lab-iot-01','lab-iot-02','lab-iot-03']:
        raise RuntimeError('Expected original fleet')
    save('previous-pods.json',pods)
    for item in bundle['items']:
        if item['kind']=='ConfigMap':
            item['data']={name:(root/name).read_text() for name in ['heartbeat-agent.mjs','kubernetes-observer.mjs','mission-agent.mjs']}
        if item['kind']=='NetworkPolicy':
            item['spec']['egress'].append({'to':[{'podSelector':{'matchLabels':{'app':'lab-target'}}}], 'ports':[{'protocol':'TCP','port':8080}]})
        if item['kind']=='Pod':
            item['spec']['restartPolicy']='Always'
            item['spec'].pop('activeDeadlineSeconds',None)
            agent=item['spec']['containers'][0]
            agent['env'] += [{'name':'FLEET_MISSION_RUNTIME','value':'1'}, {'name':'POD_UID','valueFrom':{'fieldRef':{'fieldPath':'metadata.uid'}}}]
            agent['resources']={'requests':{'cpu':'50m','memory':'128Mi'},'limits':{'cpu':'250m','memory':'256Mi'}}
    bundle['items'].append({'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':'fleet-missions-target-ingress','namespace':ns},'spec':{'podSelector':{'matchLabels':{'app':'lab-target'}},'policyTypes':['Ingress'],'ingress':[{'from':[{'podSelector':{'matchLabels':{'app':'fleet-observer','ddostester.operation':'fleet-observers-20261014-01'}}}], 'ports':[{'protocol':'TCP','port':8080}]}]}})
    for name in ['server-ca.crt'] + [f'lab-iot-{i:02}.{ext}' for i in range(1,4) for ext in ['crt','key']]:
        shutil.copyfile(old/name,root/name)
        (root/name).chmod(0o600)
    save('public-manifests.json',bundle)
    print(json.dumps({'prepared':True,'agents':3,'extraAgents':0}))
elif args.action == 'replace':
    if not (root/'production-verified').is_file():
        raise RuntimeError('Verify production release before replacing fleet')
    bundle=json.loads((root/'public-manifests.json').read_text())
    for previous in json.loads((root/'previous-pods.json').read_text()):
        name=previous['metadata']['name']
        current=json.loads(kube('get','pod',name,'-n',ns,'-o','json'))
        if current['metadata']['uid'] != previous['metadata']['uid']:
            raise RuntimeError('Pod identity changed; preserve unexpected state')
    # Existing source/policies have a saved predecessor; use resource-version fencing.
    for item in bundle['items']:
        if item['kind'] in ['ConfigMap','NetworkPolicy']:
            if item['metadata']['name']=='fleet-missions-target-ingress':
                kube('create','-f','-',content=json.dumps(item))
            else:
                current=json.loads(kube('get',item['kind'],item['metadata']['name'],'-n',ns,'-o','json'))
                save('before-'+item['kind']+'.json',current)
                item['metadata']['resourceVersion']=current['metadata']['resourceVersion']
                kube('replace','-f','-',content=json.dumps(item))
    for previous in json.loads((root/'previous-pods.json').read_text()):
        name=previous['metadata']['name']
        kube('delete','pod',name,'-n',ns,'--wait=true','--timeout=30s')
        # No old credentials can make a replacement ready before fresh enrollment.
        kube('delete','secret',name+'-enrollment','-n',ns)
    for item in bundle['items']:
        if item['kind']=='Pod':
            kube('create','-f','-',content=json.dumps(item))
    print(json.dumps({'replaced':3,'waitingForFreshEnrollment':True}))
else:
    for _ in range(45):
        pods=json.loads(kube('get','pods','-n',ns,'-l','ddostester.operation=fleet-observers-20261014-01','-o','json'))['items']
        if len(pods)==3 and all(p.get('status',{}).get('podIP') for p in pods):
            addresses=[{'name':p['metadata']['name'],'uid':p['metadata']['uid'],'privateIp':p['status']['podIP']} for p in pods]
            if len({p['privateIp'] for p in addresses})!=3:
                raise RuntimeError('Distinct private addresses required')
            save('addresses.json',addresses)
            print(json.dumps(addresses));break
        time.sleep(1)
    else:
        raise RuntimeError('Address allocation timed out')
