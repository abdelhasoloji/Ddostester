"""Kill only the identified control container inside the private lab node."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

state = Path(sys.argv[1])
if os.geteuid() != 0 or not state.is_dir() or state.stat().st_mode & 0o077:
    raise RuntimeError('Root and private laboratory state required')
node = 'k3d-ddostester-linux-lab-server-0'
proof = json.loads((state / 'creation-proof.json').read_text())
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if info['Id'] != proof['nodeId'] or info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
    raise RuntimeError('Lab node identity mismatch')
pods = json.loads(subprocess.check_output(['docker', 'exec', node, 'kubectl', '-n', 'ddostester-lab',
    'get', 'pods', '-l', 'app=lab-control', '-o', 'json'], text=True))['items']
active = [pod for pod in pods if not pod['metadata'].get('deletionTimestamp') and pod['status']['phase'] == 'Running']
if len(active) != 1:
    raise RuntimeError('Exactly one running laboratory control Pod required')
pod = active[0]
container = next(item for item in pod['status']['containerStatuses'] if item['name'] == 'control')
if not container['ready'] or not container['containerID'].startswith('containerd://'):
    raise RuntimeError('Identified ready control container required')
container_id = container['containerID'].split('://', 1)[1]
detail = json.loads(subprocess.check_output(['docker', 'exec', node, 'crictl', 'inspect', container_id], text=True))
pid = int(detail['info']['pid'])
if pid <= 1:
    raise RuntimeError('Invalid isolated process PID')
command = subprocess.check_output(['docker', 'exec', node, 'cat', '/proc/' + str(pid) + '/cmdline'])
if b'backend/dist/server.js' not in command.split(b'\0'):
    raise RuntimeError('Process is not the laboratory control server')
signal_anchor = {'wallMs': time.time_ns() // 1000000, 'monotonicMs': time.monotonic_ns() // 1000000}
subprocess.run(['docker', 'exec', node, 'kill', '-KILL', str(pid)], check=True, timeout=10)
print(json.dumps({'crashed': True, 'signalAnchor': signal_anchor,
    'podUid': pod['metadata']['uid'], 'containerId': container_id, 'nodeId': info['Id']}))
