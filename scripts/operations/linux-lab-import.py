"""Verify amd64 archive provenance before importing only the lab image set."""
import hashlib
import argparse
import json
import os
import subprocess
import sys
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('state')
parser.add_argument('archive')
parser.add_argument('receipt')
mode = parser.add_mutually_exclusive_group()
mode.add_argument('--control-only', action='store_true')
mode.add_argument('--probe-only', action='store_true')
args = parser.parse_args()
state, archive_path, receipt_path = map(Path, [args.state, args.archive, args.receipt])
proof = json.loads((state / 'creation-proof.json').read_text())
node = 'k3d-ddostester-linux-lab-server-0'
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if os.geteuid() != 0 or proof.get('nodeId') != info['Id'] or info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
    raise RuntimeError('Current node does not match private creation evidence')
receipt = json.loads(receipt_path.read_text())
expected = {'docker.io/library/ddostester-lab-' + name + ':linux-amd64' for name in ['control', 'target', 'probe', 'telemetry', 'postgres']}
if args.control_only or args.probe_only:
    expected = {'docker.io/library/ddostester-lab-probe:linux-amd64-quality' if args.probe_only else 'docker.io/library/ddostester-lab-control:linux-amd64'}
    jobs = json.loads(subprocess.check_output(['docker', 'exec', node, 'kubectl', '-n', 'ddostester-lab', 'get', 'jobs', '-l', 'app=lab-agent', '-o', 'json'], text=True))['items']
    if jobs:
        raise RuntimeError('Active lab Jobs preserved; image update refused')
if archive_path.stat().st_size != receipt['bytes'] or receipt['bytes'] > 2 * 1024**3:
    raise RuntimeError('Archive size mismatch')
digest = hashlib.sha256()
with archive_path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != receipt['archiveSha256']:
    raise RuntimeError('Archive checksum mismatch')
images = {}
with tarfile.open(archive_path) as archive:
    def read_json(path, expected_digest=None):
        member = archive.getmember(path)
        if not member.isfile() or member.size > 1024 * 1024:
            raise RuntimeError('Invalid image metadata')
        data = archive.extractfile(member).read()
        if expected_digest and hashlib.sha256(data).hexdigest() != expected_digest:
            raise RuntimeError('Image metadata digest mismatch')
        return json.loads(data)
    index = read_json('index.json')
    if len(index['manifests']) != len(expected):
        raise RuntimeError('Unexpected image count')
    for descriptor in index['manifests']:
        name = descriptor['annotations']['io.containerd.image.name']
        if name not in expected or name in images:
            raise RuntimeError('Unexpected image name')
        sha = descriptor['digest'].removeprefix('sha256:')
        manifest = read_json('blobs/sha256/' + sha, sha)
        if manifest.get('mediaType') == 'application/vnd.oci.image.index.v1+json':
            children = manifest.get('manifests', [])
            if not 1 <= len(children) <= 8:
                raise RuntimeError('Invalid nested image index')
            runnable = []
            for child in children:
                platform = child.get('platform', {})
                if platform == {'architecture': 'amd64', 'os': 'linux'}:
                    runnable.append(child)
                elif (platform == {'architecture': 'unknown', 'os': 'unknown'}
                      and child.get('annotations', {}).get('vnd.docker.reference.type') == 'attestation-manifest'):
                    attestation_sha = child['digest'].removeprefix('sha256:')
                    read_json('blobs/sha256/' + attestation_sha, attestation_sha)
                else:
                    raise RuntimeError('Unexpected nested image platform')
            if len(runnable) != 1:
                raise RuntimeError('Exactly one Linux amd64 runtime required')
            runtime_sha = runnable[0]['digest'].removeprefix('sha256:')
            manifest = read_json('blobs/sha256/' + runtime_sha, runtime_sha)
        config_sha = manifest['config']['digest'].removeprefix('sha256:')
        config = read_json('blobs/sha256/' + config_sha, config_sha)
        if config['architecture'] != 'amd64' or config['os'] != 'linux':
            raise RuntimeError('Image platform mismatch')
        images[name] = descriptor['digest']
if set(images) != expected:
    raise RuntimeError('Missing lab image')
update_prefix = 'probe-update-' if args.probe_only else 'control-update-'
log = state / (update_prefix + digest.hexdigest()[:12] + '.log' if args.control_only or args.probe_only else 'image-import.log')
with archive_path.open('rb') as source, log.open('x') as output:
    log.chmod(0o600)
    subprocess.run(['docker', 'exec', '-i', node, 'ctr', '--namespace=k8s.io', 'images', 'import', '--all-platforms', '-'], stdin=source, stdout=output, stderr=output, check=True, timeout=120)
for name, image_digest in images.items():
    local = name.replace(':linux-amd64-quality', ':quality').replace(':linux-amd64', ':local')
    immutable = name.split(':')[0] + '@' + image_digest
    subprocess.run(['docker', 'exec', node, 'ctr', '--namespace=k8s.io', 'images', 'tag', '--force', name, local], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['docker', 'exec', node, 'ctr', '--namespace=k8s.io', 'images', 'tag', name, immutable], check=True, stdout=subprocess.DEVNULL)
image_name = 'docker.io/library/ddostester-lab-probe:linux-amd64-quality' if args.probe_only else 'docker.io/library/ddostester-lab-control:linux-amd64'
image_key = 'probeImage' if args.probe_only else 'agentImage'
result = {'archiveSha256': receipt['archiveSha256'], 'images': images,
          image_key: image_name.split(':')[0] + '@' + images[image_name]}
proof_name = update_prefix + digest.hexdigest()[:12] + '.json' if args.control_only or args.probe_only else 'image-import-proof.json'
fd = os.open(state / proof_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as output:
    json.dump(result, output)
print(json.dumps({'imagesImported': len(images), 'platform': 'linux/amd64', image_key: result[image_key]}))
