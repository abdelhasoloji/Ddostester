"""Delete only an identified lab; application data deletion requires an explicit flag."""
import argparse
import hashlib
import json
import os
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('lock_file')
parser.add_argument('creation_proof')
parser.add_argument('--delete-lab-workloads', action='store_true')
args = parser.parse_args()
proof_path = Path(args.creation_proof)
if os.geteuid() != 0 or proof_path.stat().st_mode & 0o077:
    raise RuntimeError('Root and private creation proof required')
proof = json.loads(proof_path.read_text())
name = 'ddostester-linux-lab'
node = 'k3d-' + name + '-server-0'
if proof.get('cluster') != name or proof.get('node') != node or proof.get('ready') is not True:
    raise RuntimeError('Creation proof does not identify the dedicated lab')
lock = json.loads(Path(args.lock_file).read_text())
binary = Path('/usr/local/lib/ddostester-lab/k3d-v5.9.0')
if hashlib.sha256(binary.read_bytes()).hexdigest() != lock['k3d']['linuxAmd64Sha256']:
    raise RuntimeError('Unverified k3d binary')
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab' or info['Config']['Labels'].get('k3d.cluster') != name:
    raise RuntimeError('Unrelated container preserved')
if proof.get('nodeId') and proof['nodeId'] != info['Id']:
    raise RuntimeError('Node was replaced after this proof')
if info['Config']['Image'] != proof['image']:
    raise RuntimeError('Node image differs from creation proof')
def query(resource):
    return json.loads(subprocess.check_output(['docker', 'exec', node, 'kubectl', 'get', resource, '--all-namespaces', '-o', 'json'], text=True, timeout=15))['items']
namespaces = query('namespaces')
standard = {'default', 'kube-system', 'kube-public', 'kube-node-lease'}
for namespace in namespaces:
    namespace_name = namespace['metadata']['name']
    if namespace_name in standard:
        continue
    if namespace_name != 'ddostester-lab' or namespace['metadata'].get('labels', {}).get('app.kubernetes.io/part-of') != 'ddostester-lab':
        raise RuntimeError('Unknown namespace preserved')
    if not args.delete_lab_workloads:
        raise RuntimeError('Export lab evidence first; application deletion requires --delete-lab-workloads')
if any(pod['metadata']['namespace'] not in {'kube-system', 'ddostester-lab'} for pod in query('pods')):
    raise RuntimeError('Non-laboratory pods preserved')
if any(pvc['metadata']['namespace'] != 'ddostester-lab' or not args.delete_lab_workloads for pvc in query('pvc')):
    raise RuntimeError('Persistent data outside explicit deletion scope preserved')
state = proof_path.parent
fd = os.open(state / 'cleanup-intent.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump({'cluster': name, 'nodeId': info['Id'], 'applicationDeletion': args.delete_lab_workloads}, output)
with (state / 'cleanup.log').open('x') as output:
    (state / 'cleanup.log').chmod(0o600)
    subprocess.run([str(binary), 'cluster', 'delete', name], check=True, stdout=output, stderr=output, timeout=60)
if subprocess.run(['docker', 'inspect', node], capture_output=True).returncode == 0:
    raise RuntimeError('Deletion not confirmed')
print(json.dumps({'clusterDeleted': name, 'evidencePreserved': str(state)}))
