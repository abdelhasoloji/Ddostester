"""Export locally in the bounded builder, without streaming through a Docker SSH tunnel."""
import argparse
import hashlib
import json
import subprocess
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('state')
parser.add_argument('--attempt', type=int, required=True, choices=range(1, 100))
parser.add_argument('--source-directory', default='/tmp/ddostester-source')
parser.add_argument('--source-sha256')
args = parser.parse_args()
state = Path(args.state)
if not re.fullmatch(r'/tmp/ddostester-source(?:-[0-9]{2})?', args.source_directory):
    raise RuntimeError('Unexpected builder source directory')
if args.source_sha256 is not None and not re.fullmatch(r'[a-f0-9]{64}', args.source_sha256):
    raise RuntimeError('Invalid source archive checksum')
reference = 'snapshot:' + args.source_sha256 if args.source_sha256 else 'roadmap-development'
builder = 'buildx_buildkit_ddostester-vps-builder0'
info = json.loads(subprocess.check_output(['docker', 'inspect', builder], text=True))[0]
if info['HostConfig']['Memory'] != 1536 * 1024**2 or info['HostConfig']['CpuQuota'] != 50000 or info['HostConfig']['CpuPeriod'] != 100000:
    raise RuntimeError('Builder resource bounds differ from reviewed configuration')
if info['Config']['Image'] != 'moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea':
    raise RuntimeError('Unexpected builder image')
log = state / ('native-export-' + str(args.attempt) + '.log')
with log.open('x') as output:
    log.chmod(0o600)
    subprocess.run(['docker', 'exec', builder, 'buildctl', 'build', '--frontend', 'dockerfile.v0',
        '--local', 'context=' + args.source_directory, '--local', 'dockerfile=' + args.source_directory,
        '--opt', 'filename=backend/Dockerfile', '--opt', 'platform=linux/amd64',
        '--opt', 'build-arg:SHIELDTEST_COMMIT=' + reference, '--opt', 'build-arg:SHIELDTEST_BUILD=lab',
        '--output', 'type=oci,name=docker.io/library/ddostester-lab-control:linux-amd64,dest=/tmp/control-settlement.tar'],
        check=True, stdout=output, stderr=output, timeout=900)
archive = state / 'control-settlement.tar'
if archive.exists():
    raise RuntimeError('Existing exported archive preserved')
subprocess.run(['docker', 'cp', builder + ':/tmp/control-settlement.tar', str(archive)], check=True)
archive.chmod(0o600)
digest = hashlib.sha256()
with archive.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
proof = {'bytes': archive.stat().st_size, 'archiveSha256': digest.hexdigest(), 'images': ['ddostester-lab-control:linux-amd64'],
         'sourceArchiveSha256': args.source_sha256, 'sourceDirectory': args.source_directory}
path = state / 'control-settlement-receipt.json'
with path.open('x') as output:
    path.chmod(0o600)
    json.dump(proof, output)
print(json.dumps(proof))
