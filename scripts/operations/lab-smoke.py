"""Explicit, low-budget smoke run against the fixed private laboratory target."""
import argparse
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('origin')
parser.add_argument('credentials_file')
parser.add_argument('new_evidence_directory')
parser.add_argument('--duration', type=int, default=10, choices=[10, 30])
parser.add_argument('--require-complete', action='store_true',
                    help='Fail unless all shards succeed and target receipts match emitted requests')
args = parser.parse_args()
origin = urlsplit(args.origin)
if origin.scheme != 'http' or origin.hostname not in {'127.0.0.1', 'localhost'} or origin.path not in {'', '/'} or origin.query or origin.username:
    raise RuntimeError('Operator endpoint must be a loopback lab port-forward')
credentials_path = Path(args.credentials_file)
if credentials_path.stat().st_mode & 0o077:
    raise RuntimeError('Credentials must be owner-private')
credentials = json.loads(credentials_path.read_text())
destination = Path(args.new_evidence_directory)
destination.mkdir(mode=0o700)
token = None
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def call(method, path, body=None):
    headers = {'content-type': 'application/json'}
    if token:
        headers['authorization'] = 'Bearer ' + token
    request = urllib.request.Request(args.origin.rstrip('/') + path, headers=headers, method=method,
                                     data=json.dumps(body).encode() if body is not None else None)
    with opener.open(request, timeout=60) as response:
        return json.load(response)
def preserve(name, value):
    fd = os.open(destination / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump(value, output)
call('GET', '/health')
token = call('POST', '/api/auth/login', {'email': 'abdelha@wedos', 'password': credentials['owner-password']})['token']
status = call('GET', '/api/fleet/status')
if status.get('configured') is not True or status.get('available') is not True:
    raise RuntimeError('Fleet coordinator is not available')
limits = call('GET', '/api/limits')['effective']
if not (3 <= limits['maxRps'] <= 15 and 3 <= limits['maxConcurrency'] <= 6 and 10 <= limits['maxDurationSec'] <= 60):
    raise RuntimeError('Lab operational limits must be configured before smoke run')
campaign = call('POST', '/api/campaigns', {'name': 'Isolated fleet smoke', 'target': 'http://lab-target:8080/health',
    'probeUrl': 'http://lab-target:8080/health', 'probeVantage': 'remote', 'vector': 'http-get', 'agent': 'fleet',
    'maxRps': 3, 'concurrency': 3, 'maxDurationSec': args.duration, 'authorized': True})
preserve('campaign.json', campaign)
run = call('POST', '/api/campaigns/' + campaign['id'] + '/execute', {'confirmed': True})
preserve('run.json', run)
bundle = call('GET', '/api/runs/' + run['runId'] + '/fleet-evidence.json')
preserve('fleet-evidence.json', bundle)
# The evidence contract hashes JavaScript JSON.stringify, including number formatting.
# Use the same serialization rather than treating Python JSON as canonical JSON.
subprocess.run(['node', '--input-type=module', '-e',
    'import fs from "node:fs"; import {createHash} from "node:crypto"; '
    'const b=JSON.parse(fs.readFileSync(0,"utf8")); '
    'if(createHash("sha256").update(JSON.stringify(b.content)).digest("hex")!==b.sha256) '
    'throw new Error("Evidence checksum mismatch");'],
    input=json.dumps(bundle), text=True, check=True, timeout=10)
fleet = run['generator']['fleet']
if args.require_complete:
    receipts = (run.get('targetTelemetry') or [{}])[-1]
    if (fleet['measurementComplete'] is not True
            or any(shard['state'] != 'SUCCEEDED' for shard in fleet['shards'])
            or receipts.get('receiptComplete') is not True
            or receipts.get('receivedRequests') != run['generator']['totalRequests']
            or len(set(receipts.get('sourceIps', []))) != 3):
        raise RuntimeError('Complete fleet measurement not proven; preserved evidence remains available')
print(json.dumps({'runId': run['runId'], 'status': run['status'], 'complete': fleet['measurementComplete'],
                  'requests': run['generator']['totalRequests'], 'states': [shard['state'] for shard in fleet['shards']],
                  'privateSources': [(shard.get('result') or {}).get('podIp') for shard in fleet['shards']]}))
