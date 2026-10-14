#!/usr/bin/env python3
"""Private pg-tools bridge for the identified lab node, never the production DB."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

tool = Path(sys.argv[0]).name
if tool not in {'pg_dump', 'psql', 'pg_restore'}:
    raise RuntimeError('Install private symlinks named pg_dump, psql and pg_restore')
state = Path(os.environ['DDOSTESTER_LAB_STATE'])
if not re.fullmatch(r'/var/lib/ddostester-linux-lab-attempt-[0-9]{2}', str(state)):
    raise RuntimeError('Unexpected lab state')
node = 'k3d-ddostester-linux-lab-server-0'
proof = json.loads((state / 'creation-proof.json').read_text())
info = json.loads(subprocess.check_output(['docker', 'inspect', node], text=True))[0]
if os.geteuid() != 0 or info['Id'] != proof['nodeId'] or info['Config']['Labels'].get('ddostester.purpose') != 'isolated-linux-lab':
    raise RuntimeError('Lab node identity mismatch')
database = os.environ.get('PGDATABASE', '')
recovery = re.fullmatch(r'ddostester_lab_restore_[a-f0-9]{12}', database)
args = sys.argv[1:]
source = None
if tool == 'pg_dump':
    if database != 'ddostester_lab' or args != ['--format=custom', '--no-owner', '--no-acl']:
        raise RuntimeError('Only the dedicated lab may be backed up')
elif tool == 'psql':
    expected = ['--no-psqlrc', '--tuples-only', '--no-align', '--command',
                "SELECT count(*) FROM pg_tables WHERE schemaname='public';"]
    if not recovery or args != expected:
        raise RuntimeError('Only the empty recovery-table check is allowed')
else:
    if not recovery or args[:-1] != ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl', '--dbname', database]:
        raise RuntimeError('Only an explicit transactional recovery is allowed')
    path = Path(args[-1])
    if not re.fullmatch(r'/tmp/ddostester-recovery-[A-Za-z0-9_-]+/verified.dump', str(path)):
        raise RuntimeError('Unexpected verified recovery file')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    details = os.fstat(fd)
    if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_mode & 0o077 or details.st_size > 256 * 1024**2:
        os.close(fd)
        raise RuntimeError('Recovery file must be regular, private and bounded')
    source = os.fdopen(fd, 'rb')
    args = ['--single-transaction', '--exit-on-error', '--no-owner', '--no-acl']
command = ['docker', 'exec', '-i', node, 'kubectl', '-n', 'ddostester-lab',
           'exec', '-i', 'statefulset/lab-postgres', '--', tool, '-U', 'ddostester_lab',
           '--dbname', database, *args]
try:
    result = subprocess.run(command, stdin=source if source else subprocess.DEVNULL, timeout=600)
finally:
    if source:
        source.close()
raise SystemExit(result.returncode)
