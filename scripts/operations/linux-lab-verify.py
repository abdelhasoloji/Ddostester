import hashlib
import json
import sys
from pathlib import Path
from linux_lab import verify_lab

lock = json.loads(Path(sys.argv[1]).read_text())
state = Path(sys.argv[2])
if not state.is_dir() or state.stat().st_mode & 0o077:
    raise RuntimeError('Existing private operation directory required')
binary = Path('/usr/local/lib/ddostester-lab/k3d-v5.9.0')
if hashlib.sha256(binary.read_bytes()).hexdigest() != lock['k3d']['linuxAmd64Sha256']:
    raise RuntimeError('Unverified k3d binary')
print(json.dumps(verify_lab(binary, lock, state)))
