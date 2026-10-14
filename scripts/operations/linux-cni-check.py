"""Check fresh private TCP connections; no campaign, HTTP payload or public destination."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('kubeconfig')
parser.add_argument('ssh_key')
parser.add_argument('evidence_directory')
args = parser.parse_args()
if Path(args.ssh_key).stat().st_mode & 0o077:
    raise RuntimeError('Private host key required')
directory = Path(args.evidence_directory); directory.mkdir(mode=0o700)
def preserve(name, value):
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(value, output)
def kube(*arguments, content=None):
    return subprocess.run(['kubectl', '--kubeconfig', args.kubeconfig,
        '--server=https://127.0.0.1:16643', '-n', 'ddostester-lab', *arguments],
        input=content, text=True, capture_output=True, check=True, timeout=40).stdout
if kube('config', 'current-context').strip() != 'k3d-ddostester-linux-lab':
    raise RuntimeError('Identified Linux laboratory required')
if json.loads(kube('get', 'jobs', '-l', 'app=lab-agent', '-o', 'json'))['items']:
    raise RuntimeError('Existing fleet Jobs preserved; CNI mutation refused')
control = json.loads(kube('get', 'deployment', 'lab-control', '-o', 'json'))
image = next(container['image'] for container in control['spec']['template']['spec']['containers'] if container['name'] == 'control')
if not re.fullmatch(r'docker.io/library/ddostester-lab-control@sha256:[a-f0-9]{64}', image):
    raise RuntimeError('Identified immutable lab image required')
pod_name = 'lab-cni-check-' + uuid.uuid4().hex[:8]
pod = {'apiVersion': 'v1', 'kind': 'Pod', 'metadata': {'name': pod_name, 'namespace': 'ddostester-lab',
    'labels': {'app': 'lab-agent', 'purpose': 'cni-check'}}, 'spec': {
    'restartPolicy': 'Never', 'activeDeadlineSeconds': 120, 'automountServiceAccountToken': False,
    'securityContext': {'runAsNonRoot': True, 'runAsUser': 1000, 'runAsGroup': 1000,
        'seccompProfile': {'type': 'RuntimeDefault'}},
    'containers': [{'name': 'check', 'image': image, 'imagePullPolicy': 'Never',
        'command': ['node', '-e', 'setTimeout(()=>process.exit(0),110000)'],
        'resources': {'requests': {'cpu': '50m', 'memory': '64Mi'}, 'limits': {'cpu': '100m', 'memory': '128Mi'}},
        'securityContext': {'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True,
            'capabilities': {'drop': ['ALL']}}}]}}
script = '''const net=require('node:net');const cases=JSON.parse(process.argv[1]);
(async()=>{const results=[];for(const [host,port] of cases){let address=null;
results.push(await new Promise(resolve=>{const socket=net.createConnection({host,port});
const timer=setTimeout(()=>finish(false,'timeout'),2000);
function finish(connected,error){clearTimeout(timer);socket.destroy();resolve({host,port,address,connected,error});}
socket.on('lookup',(_,ip)=>address=ip);socket.once('connect',()=>finish(true,null));
socket.once('error',error=>finish(false,error.code));}));}
console.log(JSON.stringify(results));})().catch(()=>process.exit(1));'''
def sample(subject, container, cases):
    return json.loads(kube('exec', subject, '-c', container, '--', 'node', '-e', script, json.dumps(cases)))
restore = None
try:
    kube('create', '-f', '-', content=json.dumps(pod))
    kube('wait', '--for=condition=Ready', 'pod/' + pod_name, '--timeout=30s')
    live_services = sample('deployment/lab-control', 'control', [['lab-postgres', 5432], ['lab-probe', 8099]])
    preserve('services-live.json', live_services)
    if not all(row['connected'] for row in live_services): raise RuntimeError('Forbidden service is unavailable; CNI check inconclusive')
    before = sample(pod_name, 'check', [['lab-target', 8080], ['lab-fleet', 8443], ['lab-postgres', 5432], ['lab-probe', 8099]])
    preserve('before.json', before)
    if [row['connected'] for row in before] != [True, True, False, False]:
        raise RuntimeError('Initial CNI isolation not proven; evidence retained')
    policy = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
    armed = json.loads(subprocess.check_output(['ssh', '-i', args.ssh_key, '-o', 'BatchMode=yes',
        '-o', 'StrictHostKeyChecking=yes', 'root@31.31.74.187',
        'python3 /usr/local/lib/ddostester-lab/linux-policy-rollback.py /var/lib/ddostester-linux-lab-attempt-03 --arm --delay 60'], text=True, timeout=20))
    preserve('rollback.json', armed)
    if armed.get('armed') is not True: raise RuntimeError('Rollback not armed')
    restore = {'apiVersion': policy['apiVersion'], 'kind': policy['kind'],
        'metadata': {key: value for key, value in policy['metadata'].items()
            if key in {'name', 'namespace', 'labels', 'annotations'}}, 'spec': policy['spec']}
    preserve('policy-before.json', restore)
    kube('delete', 'networkpolicy', 'agent-coordinator')
    blocked = sample(pod_name, 'check', [['lab-fleet', 8443], ['lab-target', 8080]])
    preserve('blocked.json', blocked)
    if [row['connected'] for row in blocked] != [False, True]: raise RuntimeError('New coordinator connection not blocked by CNI')
finally:
    try:
        if restore:
            kube('apply', '-f', '-', content=json.dumps(restore))
            restored = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
            if restored['spec'] != restore['spec']: raise RuntimeError('Policy restoration differs')
            preserve('policy-restored.json', {'restored': True})
            for attempt in range(4):
                after = sample(pod_name, 'check', [['lab-fleet', 8443], ['lab-target', 8080]])
                if all(row['connected'] for row in after): break
                time.sleep(0.3)
            preserve('after.json', after)
            if not all(row['connected'] for row in after): raise RuntimeError('Restored private connectivity not proven')
    finally:
        kube('delete', 'pod', pod_name, '--ignore-not-found', '--wait=true', '--timeout=30s')
print(json.dumps({'freshConnectionsVerified': True, 'forbiddenServicesBlocked': True,
    'coordinatorBlockedAfterPolicyRemoval': True, 'targetStillReachable': True}))
