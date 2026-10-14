"""Private, deterministic source archive; never modifies the checkout or Git index."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile

parser = argparse.ArgumentParser()
parser.add_argument('archive', help='New archive outside the repository')
args = parser.parse_args()
root = Path(subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip())
destination = Path(args.archive).absolute()
if destination.is_relative_to(root) or not destination.parent.is_dir():
    raise RuntimeError('Use an existing private directory outside the checkout')
if destination.parent.stat().st_mode & 0o077:
    raise RuntimeError('Archive parent must be owner-private')
receipt_path = Path(str(destination) + '.json')
if destination.exists() or receipt_path.exists():
    raise RuntimeError('Existing evidence is preserved')
head = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
files, skipped = [], []
total = 0
for name in sorted(set(filter(None, names))):
    path = root / name
    if path.is_symlink() or path.name == '.DS_Store' or not path.is_file():
        skipped.append(name)
        continue
    if name == 'ddostester-source-manifest.json':
        raise RuntimeError('Reserved manifest filename already exists')
    before = path.stat()
    if before.st_size > 16 * 1024**2:
        raise RuntimeError('Source file exceeds archive budget')
    content = path.read_bytes()
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise RuntimeError('Source changed while reading')
    total += len(content)
    if total > 256 * 1024**2:
        raise RuntimeError('Source archive budget exceeded')
    files.append((name, content, after))
for name, _, before in files:
    after = (root / name).stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise RuntimeError('Source changed during snapshot')
if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != head:
    raise RuntimeError('Git reference changed during snapshot')
if sorted(set(filter(None, subprocess.check_output(['git', '-C', str(root), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')))) != sorted(set(filter(None, names))):
    raise RuntimeError('Source inventory changed during snapshot')
manifest = {'schema': 'ddostester.source.snapshot/v1', 'head': head, 'excluded': skipped,
    'files': [{'path': name, 'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
               'mode': 0o755 if metadata.st_mode & 0o111 else 0o644} for name, content, metadata in files]}
manifest_bytes = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    with os.fdopen(fd, 'wb') as output, gzip.GzipFile(fileobj=output, mode='wb', filename='', mtime=0) as zipped, tarfile.open(fileobj=zipped, mode='w') as archive:
        for name, content, metadata in files + [('ddostester-source-manifest.json', manifest_bytes, None)]:
            entry = tarfile.TarInfo(name)
            entry.size = len(content)
            entry.mode = 0o755 if metadata and metadata.st_mode & 0o111 else 0o644
            archive.addfile(entry, io.BytesIO(content))
    receipt = {'schema': manifest['schema'], 'head': head, 'files': len(files),
        'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(),
        'bytes': destination.stat().st_size, 'sourceArchiveSha256': hashlib.sha256(destination.read_bytes()).hexdigest()}
    proof_fd = os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(proof_fd, 'w') as proof:
        json.dump(receipt, proof)
    print(json.dumps(receipt))
except BaseException:
    destination.unlink(missing_ok=True)
    raise
