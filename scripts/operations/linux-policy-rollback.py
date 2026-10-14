"""Host-side, identity-fenced rollback for the single lab coordinator egress policy."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import uuid

parser = argparse.ArgumentParser()
parser.add_argument('state')
parser.add_argument('--arm', action='store_true')
parser.add_argument('--delay', type=int, default=60, choices=range(10, 121))
args = parser.parse_args()
state = Path(args.state)
if os.geteuid() != 0 or not state.is_dir() or state.stat().st_mode & 0o077:
    raise RuntimeError('Root and private lab operation directory required')
node = 'k3d-ddostester-linux-lab-server-0'
proof = json.loads((state / 'creation-proof.json').read_text())
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if info['Id'] != proof['nodeId'] or info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
    raise RuntimeError('Current node does not match laboratory creation evidence')
expected = {'podSelector': {'matchLabels': {'app': 'lab-agent'}}, 'policyTypes': ['Egress'],
    'egress': [{'to': [{'podSelector': {'matchLabels': {'app': 'lab-fleet'}}}],
        'ports': [{'protocol': 'TCP', 'port': 8443}]}]}
def kube(*arguments, content=None):
    return subprocess.run(['docker', 'exec', *(['-i'] if content else []), node,
        'kubectl', '-n', 'ddostester-lab', *arguments], input=content, text=True,
        capture_output=True, check=True, timeout=20).stdout
if args.arm:
    existing = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
    if existing['spec'] != expected:
        raise RuntimeError('Existing policy differs; rollback not armed')
    unit = 'ddostester-policy-rollback-' + uuid.uuid4().hex[:12]
    subprocess.run(['systemd-run', '--unit=' + unit, '--on-active=' + str(args.delay) + 's',
        '--property=UMask=0077', '--property=TimeoutStartSec=45',
        'python3', str(Path(__file__).resolve()), str(state)], check=True, capture_output=True)
    timer = subprocess.check_output(['systemctl', 'show', unit + '.timer',
        '-p', 'ActiveState', '-p', 'SubState'], text=True)
    if not {'ActiveState=active', 'SubState=waiting'}.issubset(set(timer.splitlines())):
        raise RuntimeError('Host rollback timer is not actively waiting')
    print(json.dumps({'armed': True, 'unit': unit, 'delaySec': args.delay, 'nodeId': info['Id']}))
else:
    existing = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '--ignore-not-found', '-o', 'json') or 'null')
    if existing and existing['spec'] != expected:
        raise RuntimeError('Policy changed by another operator; preserved without overwrite')
    if not existing:
        resource = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy',
            'metadata': {'name': 'agent-coordinator', 'namespace': 'ddostester-lab'}, 'spec': expected}
        kube('create', '-f', '-', content=json.dumps(resource))
    restored = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
    if restored['spec'] != expected:
        raise RuntimeError('Restored policy differs')
    result = {'restored': True, 'created': existing is None, 'nodeId': info['Id'],
        'policyUid': restored['metadata']['uid']}
    path = state / ('policy-rollback-' + uuid.uuid4().hex + '.json')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(result, output)
    print(json.dumps(result))
