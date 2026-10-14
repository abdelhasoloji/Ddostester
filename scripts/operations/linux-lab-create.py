"""Create only the pinned, dedicated k3d laboratory; never merge default kubeconfig."""
import hashlib
import ipaddress
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

config, lock_file, state_arg = sys.argv[1:]
lock = json.loads(Path(lock_file).read_text())
binary = Path('/usr/local/lib/ddostester-lab/k3d-v5.9.0')
name = 'ddostester-linux-lab'
node = 'k3d-' + name + '-server-0'
if platform.system() != 'Linux' or platform.machine() != 'x86_64' or os.geteuid() != 0:
    raise RuntimeError('Requires Linux amd64 and root Docker administration')
if hashlib.sha256(binary.read_bytes()).hexdigest() != lock['k3d']['linuxAmd64Sha256']:
    raise RuntimeError('Unverified k3d binary')
if hashlib.sha256(Path(config).read_bytes()).hexdigest() != lock['clusterConfigSha256']:
    raise RuntimeError('Cluster configuration differs from the reviewed lock')

def read(args):
    return json.loads(subprocess.check_output(args, text=True, timeout=15))

if any(cluster['name'] == name for cluster in read([str(binary), 'cluster', 'list', '-o', 'json'])):
    raise RuntimeError('Existing lab cluster preserved; creation refused')
planned = [ipaddress.ip_network(cidr) for cidr in ['172.30.94.0/24', '10.247.0.0/16', '10.98.0.0/16']]
routes = read(['ip', '-j', '-4', 'route'])
for route in routes:
    destination = route.get('dst', 'default')
    if destination != 'default' and any(ipaddress.ip_network(destination, strict=False).overlaps(cidr) for cidr in planned):
        raise RuntimeError('Laboratory CIDR overlaps an existing route')
networks = subprocess.check_output(['docker', 'network', 'ls', '-q'], text=True).split()
if networks:
    for network in read(['docker', 'network', 'inspect', *networks]):
        for pool in network.get('IPAM', {}).get('Config', []) or []:
            if pool.get('Subnet') and ':' not in pool['Subnet'] and any(ipaddress.ip_network(pool['Subnet']).overlaps(cidr) for cidr in planned):
                raise RuntimeError('Laboratory CIDR overlaps Docker networking')
available = next(int(line.split()[1]) * 1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
if available < 5 * 1024**3 or shutil.disk_usage('/var/lib').free < 20 * 1024**3:
    raise RuntimeError('Insufficient headroom for the isolated lab')
with socket.socket() as check:
    check.bind(('127.0.0.1', 16643))
state = Path(state_arg)
state.mkdir(mode=0o700)  # Never overwrite an existing operation's evidence.
log = state / 'creation.log'
with log.open('x') as output:
    log.chmod(0o600)
    process = subprocess.Popen([str(binary), 'cluster', 'create', '--config', config,
        '--servers-memory', '4g', '--no-rollback', '--timeout', '120s'], stdout=output, stderr=output,
        env={**os.environ, 'K3D_IMAGE_TOOLS': lock['k3d']['toolsImage']})
    capped = False
    deadline = time.monotonic() + 180
    try:
        while process.poll() is None:
            if time.monotonic() > deadline:
                process.kill()
                raise RuntimeError('Cluster creation deadline exceeded; partial lab preserved')
            if not capped:
                probe = subprocess.run(['docker', 'inspect', node], capture_output=True, text=True, timeout=10)
                if probe.returncode == 0:
                    info = json.loads(probe.stdout)[0]
                    if info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
                        raise RuntimeError('Refusing to cap an unrelated container')
                    subprocess.run(['docker', 'update', '--cpus', '1.5', '--memory', '4g', '--memory-swap', '4g', node], check=True, stdout=subprocess.DEVNULL)
                    capped = True
            time.sleep(0.5)
        if process.returncode != 0 or not capped:
            raise RuntimeError('Cluster creation failed; inspect private creation log')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
from linux_lab import verify_lab
proof = verify_lab(binary, lock, state)
print(json.dumps(proof))
