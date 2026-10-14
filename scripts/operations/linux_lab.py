"""Verification shared by fresh creation and recovery after a post-check failure."""
import json
import os
import subprocess

def verify_lab(binary, lock, state):
    name = 'ddostester-linux-lab'
    node = 'k3d-' + name + '-server-0'
    info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
    if info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab' or info['Config']['Labels'].get('k3d.cluster') != name:
        raise RuntimeError('Unrelated node preserved')
    limits = info['HostConfig']
    if info['Config']['Image'] != lock['k3s']['image'] or limits['NetworkMode'] == 'host' or limits['PidMode'] == 'host':
        raise RuntimeError('Node image or isolation differs from the recipe')
    if limits['NanoCpus'] != 1500000000 or limits['Memory'] != 4 * 1024**3 or limits['MemorySwap'] != 4 * 1024**3:
        raise RuntimeError('Node resource caps differ from the recipe')
    ports = info['NetworkSettings']['Ports'].get('6443/tcp')
    if not ports or any(port['HostIp'] != '127.0.0.1' or port['HostPort'] != '16643' for port in ports):
        raise RuntimeError('API exposure differs from loopback-only recipe')
    if any(bindings for port, bindings in info['NetworkSettings']['Ports'].items() if port != '6443/tcp'):
        raise RuntimeError('Unexpected published port')
    helper_probe = subprocess.run(['docker', 'inspect', 'k3d-' + name + '-tools'], capture_output=True, text=True)
    if helper_probe.returncode == 0:
        helper = json.loads(helper_probe.stdout)[0]
        if helper['Config']['Labels'].get('k3d.cluster') != name or helper['Config']['Image'] != lock['k3d']['toolsImage']:
            raise RuntimeError('Unexpected helper container')
        subprocess.run(['docker', 'update', '--cpus', '0.5', '--memory', '256m', '--memory-swap', '256m', helper['Id']], check=True, stdout=subprocess.DEVNULL)
    nodes = json.loads(subprocess.check_output(['docker', 'exec', node, 'kubectl', 'get', 'nodes', '-o', 'json'], text=True, timeout=15))['items']
    if len(nodes) != 1 or nodes[0]['metadata']['name'] != node or not any(c['type'] == 'Ready' and c['status'] == 'True' for c in nodes[0]['status']['conditions']):
        raise RuntimeError('Dedicated node is not Ready')
    kubeconfig = state / 'kubeconfig'
    fd = os.open(kubeconfig, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'wb') as output:
            subprocess.run([str(binary), 'kubeconfig', 'get', name], stdout=output, check=True)
    except Exception:
        kubeconfig.unlink()
        raise
    proof = {'cluster': name, 'node': node, 'nodeId': info['Id'], 'ready': True, 'apiLoopbackOnly': True,
             'cpuLimit': 1.5, 'memoryLimitBytes': limits['Memory'], 'image': info['Config']['Image'],
             'kubernetesVersion': nodes[0]['status']['nodeInfo']['kubeletVersion'],
             'transientHelperRemoved': helper_probe.returncode != 0, 'workloadsDeployed': False}
    fd = os.open(state / 'creation-proof.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(proof, output)
        output.write('\n')
    return proof
