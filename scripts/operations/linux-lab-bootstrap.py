"""Bootstrap identities and schema before starting the dedicated lab control plane."""
import json
import subprocess
import sys
from pathlib import Path

state, bundle_path = map(Path, sys.argv[1:])
proof = json.loads((state / 'creation-proof.json').read_text())
node = 'k3d-ddostester-linux-lab-server-0'
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if proof.get('nodeId') != info['Id'] or info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
    raise RuntimeError('Node does not match creation proof')
bundle = json.loads(bundle_path.read_text())
image_proof = json.loads((state / 'image-import-proof.json').read_text())
def kubectl(*args, payload=None):
    command = ['docker', 'exec'] + (['-i'] if payload is not None else []) + [node, 'kubectl', *args]
    result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                            capture_output=True, text=True, timeout=150)
    if result.returncode:
        raise RuntimeError('Lab Kubernetes operation failed: ' + ' '.join(args[:3]))
    return result.stdout
existing = json.loads(kubectl('get', 'namespaces', '-o', 'json'))['items']
if any(namespace['metadata']['name'] == 'ddostester-lab' for namespace in existing):
    raise RuntimeError('Existing namespace preserved; bootstrap refuses replacement')
for object in bundle['foundation']['items'] + bundle['applications']['items']:
    metadata = object['metadata']
    if object['kind'] == 'Namespace':
        if metadata['name'] != 'ddostester-lab': raise RuntimeError('Unrelated namespace')
    elif metadata.get('namespace') != 'ddostester-lab' and not (object['kind'] == 'ConfigMap' and metadata.get('namespace') == 'kube-system' and metadata['name'] == 'coredns'):
        raise RuntimeError('Unrelated resource namespace')
kubectl('apply', '-f', '-', payload=bundle['foundation'])
secrets = json.loads((state / 'identities/secrets.private.json').read_text())
kubectl('apply', '-f', '-', payload=secrets)
nodes = json.loads(kubectl('get', 'nodes', '-o', 'json'))['items']
ip = next(address['address'] for address in nodes[0]['status']['addresses'] if address['type'] == 'InternalIP')
policy = {'apiVersion': 'networking.k8s.io/v1', 'kind': 'NetworkPolicy', 'metadata': {'name': 'control-kubernetes', 'namespace': 'ddostester-lab'},
          'spec': {'podSelector': {'matchLabels': {'app': 'lab-control'}}, 'policyTypes': ['Egress'], 'egress': [
              {'to': [{'ipBlock': {'cidr': '10.98.0.1/32'}}], 'ports': [{'protocol': 'TCP', 'port': 443}]},
              {'to': [{'ipBlock': {'cidr': ip + '/32'}}], 'ports': [{'protocol': 'TCP', 'port': 6443}]}]}}
kubectl('apply', '-f', '-', payload=policy)
kubectl('-n', 'ddostester-lab', 'rollout', 'status', 'statefulset/lab-postgres', '--timeout=120s')
kubectl('-n', 'kube-system', 'rollout', 'restart', 'deployment/coredns')
kubectl('-n', 'kube-system', 'rollout', 'status', 'deployment/coredns', '--timeout=60s')
kubectl('apply', '-f', '-', payload=bundle['bootstrap'])
kubectl('-n', 'ddostester-lab', 'wait', '--for=condition=complete', 'job/lab-account-bootstrap', '--timeout=90s')
logs = kubectl('-n', 'ddostester-lab', 'logs', 'job/lab-account-bootstrap')
(state / 'account-bootstrap.log').write_text(logs)
(state / 'account-bootstrap.log').chmod(0o600)
if '"accountCount":1' not in logs:
    raise RuntimeError('Owner bootstrap proof not confirmed')
kubectl('-n', 'ddostester-lab', 'delete', 'job/lab-account-bootstrap', '--wait=true', '--timeout=30s')
for deployment in bundle['applications']['items']:
    if deployment['metadata']['name'] == 'lab-control':
        container = next(container for container in deployment['spec']['template']['spec']['containers'] if container['name'] == 'control')
        container['env'] += [{'name': 'FLEET_ENABLED', 'value': '1'}, {'name': 'FLEET_AGENT_IMAGE', 'value': image_proof['agentImage']}]
for name in ['lab-fleet', 'lab-control']:
    deployment = next(item for item in bundle['applications']['items'] if item['metadata']['name'] == name)
    kubectl('apply', '-f', '-', payload=deployment)
    kubectl('-n', 'ddostester-lab', 'rollout', 'status', 'deployment/' + name, '--timeout=120s')
for name in ['lab-target', 'lab-probe']:
    kubectl('-n', 'ddostester-lab', 'rollout', 'status', 'deployment/' + name, '--timeout=120s')
result = {'applicationReady': True, 'ownerAccounts': 1, 'namespace': 'ddostester-lab', 'agentImage': image_proof['agentImage'], 'campaignsStarted': 0}
(state / 'bootstrap-proof.json').write_text(json.dumps(result) + '\n')
print(json.dumps(result))
