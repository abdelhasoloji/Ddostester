"""Generate a new lab identity set outside the repository; never print secrets."""
import base64
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path

destination = Path(sys.argv[1]).resolve()
source_root = Path(__file__).resolve().parents[2]
if destination == source_root or source_root in destination.parents:
    raise RuntimeError('Private material must remain outside source checkout')
if any((parent / '.git').exists() for parent in [destination, *destination.parents]):
    raise RuntimeError('Private material must remain outside every Git checkout')
os.umask(0o077)
destination.mkdir(mode=0o700)
pki = destination / 'pki'
pki.mkdir(mode=0o700)
def openssl(*args):
    result = subprocess.run(['openssl', *args], capture_output=True)
    if result.returncode:
        raise RuntimeError('Certificate generation failed; private partial material retained')
def key(name):
    openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', str(pki / (name + '.key')))
key('ca')
openssl('req', '-x509', '-new', '-key', str(pki / 'ca.key'), '-sha256', '-days', '30', '-subj', '/CN=Ddostester-Lab-CA', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-out', str(pki / 'ca.crt'))
for name, cn, usage in [('server', 'lab-fleet', 'serverAuth'), ('one', 'one', 'clientAuth'), ('two', 'two', 'clientAuth'), ('three', 'three', 'clientAuth')]:
    key(name)
    openssl('req', '-new', '-key', str(pki / (name + '.key')), '-subj', '/CN=' + cn, '-out', str(pki / (name + '.csr')))
    extensions = 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=' + usage + '\n'
    if name == 'server':
        extensions += 'subjectAltName=DNS:lab-fleet,DNS:lab-fleet.ddostester-lab.svc,DNS:lab-fleet.ddostester-lab.svc.cluster.local\n'
    (pki / (name + '.ext')).write_text(extensions)
    openssl('x509', '-req', '-in', str(pki / (name + '.csr')), '-CA', str(pki / 'ca.crt'), '-CAkey', str(pki / 'ca.key'), '-CAcreateserial', '-days', '14', '-sha256', '-extfile', str(pki / (name + '.ext')), '-out', str(pki / (name + '.crt')))
    openssl('verify', '-CAfile', str(pki / 'ca.crt'), '-purpose', 'sslserver' if name == 'server' else 'sslclient', str(pki / (name + '.crt')))
password = secrets.token_hex(32)
credentials = {'database-password': password,
               'database-url': 'postgres://ddostester_lab:' + password + '@lab-postgres:5432/ddostester_lab',
               'signing-secret': secrets.token_hex(48), 'owner-password': secrets.token_urlsafe(32),
               'probe-token': secrets.token_hex(32)}
(destination / 'credentials.json').write_text(json.dumps(credentials))
def secret(name, values):
    return {'apiVersion': 'v1', 'kind': 'Secret', 'metadata': {'name': name, 'namespace': 'ddostester-lab'},
            'type': 'Opaque', 'data': {name: base64.b64encode(value if isinstance(value, bytes) else value.encode()).decode() for name, value in values.items()}}
manifests = [secret('lab-identities', {k: v for k, v in credentials.items() if k != 'probe-token'}), secret('probe-identity', {'token': credentials['probe-token']})]
for name in ['server', 'one', 'two', 'three']:
    manifests.append(secret('fleet-' + name, {'tls.key': (pki / (name + '.key')).read_bytes(), 'tls.crt': (pki / (name + '.crt')).read_bytes(), 'ca.crt': (pki / 'ca.crt').read_bytes()}))
(destination / 'secrets.private.json').write_text(json.dumps({'apiVersion': 'v1', 'kind': 'List', 'items': manifests}))
print(json.dumps({'identitiesGenerated': True, 'agents': 3, 'rootKeyExcludedFromKubernetes': True, 'destination': str(destination)}))
