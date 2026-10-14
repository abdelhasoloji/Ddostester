"""Verify an identified source snapshot without extracting or executing its contents."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('archive')
args = parser.parse_args()
path = Path(args.archive)
receipt = json.loads(Path(str(path) + '.json').read_text())
if receipt.get('schema') != 'ddostester.source.snapshot/v1' or not re.fullmatch('[a-f0-9]{40}', receipt.get('head', '')):
    raise RuntimeError('Invalid source receipt')
if path.stat().st_size != receipt['bytes'] or receipt['bytes'] > 256 * 1024**2:
    raise RuntimeError('Source archive size mismatch')
digest = hashlib.sha256()
with path.open('rb') as source:
    for chunk in iter(lambda: source.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != receipt['sourceArchiveSha256']:
    raise RuntimeError('Source archive checksum mismatch')
with tarfile.open(path) as archive:
    members = []
    content_bytes = 0
    for member in archive:
        if not member.isfile() or member.size > 16 * 1024**2:
            raise RuntimeError('Unsafe source archive member')
        content_bytes += member.size
        if content_bytes > 256 * 1024**2:
            raise RuntimeError('Source contents exceed budget')
        members.append(member)
        if len(members) > 10000:
            raise RuntimeError('Excessive archive members')
    if len({member.name for member in members}) != len(members):
        raise RuntimeError('Duplicate or excessive archive members')
    for member in members:
        parts = Path(member.name).parts
        if not member.isfile() or not parts or member.name.startswith('/') or '..' in parts or Path(member.name).as_posix() != member.name or member.size > 16 * 1024**2:
            raise RuntimeError('Unsafe source archive member')
    if sum(member.size for member in members) > 256 * 1024**2:
        raise RuntimeError('Source contents exceed budget')
    manifest_member = archive.getmember('ddostester-source-manifest.json')
    if manifest_member.size > 4 * 1024**2:
        raise RuntimeError('Manifest exceeds budget')
    raw = archive.extractfile(manifest_member).read()
    if hashlib.sha256(raw).hexdigest() != receipt['manifestSha256']:
        raise RuntimeError('Source manifest checksum mismatch')
    manifest = json.loads(raw)
    files = manifest['files']
    if manifest['schema'] != receipt['schema'] or manifest['head'] != receipt['head'] or len(files) != receipt['files']:
        raise RuntimeError('Source manifest identity mismatch')
    names = [file['path'] for file in files]
    if len(set(names)) != len(names) or set(names) | {'ddostester-source-manifest.json'} != {member.name for member in members}:
        raise RuntimeError('Source manifest inventory mismatch')
    for file in files:
        member = archive.getmember(file['path'])
        content = archive.extractfile(member).read()
        if member.size != file['bytes'] or member.mode != file['mode'] or hashlib.sha256(content).hexdigest() != file['sha256']:
            raise RuntimeError('Source file differs from manifest')
print(json.dumps({'archiveVerified': True, 'manifestVerified': True, 'filesVerified': len(files),
                 'sourceArchiveSha256': receipt['sourceArchiveSha256'], 'head': receipt['head']}))
