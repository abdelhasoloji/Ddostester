"""Bounded manual-stop recipe, corroborated by dedicated target receipts."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit

parser = argparse.ArgumentParser()
parser.add_argument('origin')
parser.add_argument('credentials')
parser.add_argument('kubeconfig')
parser.add_argument('evidence_directory')
parser.add_argument('--mode', choices=['manual', 'coordinator-outage', 'coordinator-degraded',
    'coordinator-restart', 'policy-removal', 'control-crash'], default='manual')
parser.add_argument('--ssh-key', help='Private Linux lab host key; required for policy-removal rollback')
args = parser.parse_args()
origin = urlsplit(args.origin)
if origin.scheme != 'http' or origin.hostname != '127.0.0.1' or origin.path not in {'', '/'} or origin.query or origin.username:
    raise RuntimeError('Explicit loopback operator endpoint required')
credentials_path = Path(args.credentials)
if credentials_path.stat().st_mode & 0o077:
    raise RuntimeError('Credentials must be private')
credentials = json.loads(credentials_path.read_text())
directory = Path(args.evidence_directory)
directory.mkdir(mode=0o700)
def preserve(name, value):
    fd = os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output: json.dump(value, output)
server_override = None
def kube(*arguments, timeout=20):
    return subprocess.check_output(['kubectl', '--kubeconfig', args.kubeconfig,
        *(['--server', server_override] if server_override else []),
        '-n', 'ddostester-lab', *arguments], text=True, timeout=timeout)
context = kube('config', 'current-context').strip()
if context not in {'kind-ddostester-lab', 'k3d-ddostester-linux-lab'}:
    raise RuntimeError('Only the identified private laboratory contexts are accepted')
if args.mode in {'policy-removal', 'control-crash'}:
    if context != 'k3d-ddostester-linux-lab' or not args.ssh_key or Path(args.ssh_key).stat().st_mode & 0o077:
        raise RuntimeError('Policy injection requires the Linux lab and its private host rollback key')
api = urlsplit(kube('config', 'view', '--minify', '-o', 'jsonpath={.clusters[0].cluster.server}').strip())
if api.scheme != 'https' or api.hostname not in {'127.0.0.1', 'localhost', '::1'}:
    raise RuntimeError('Laboratory Kubernetes API must use an explicit loopback endpoint')
server_override = api.geturl().replace('https://localhost:', 'https://127.0.0.1:')
token = None
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl): return None
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
def call(method, path, body=None):
    headers = {'content-type': 'application/json'}
    if token: headers['authorization'] = 'Bearer ' + token
    request = urllib.request.Request(args.origin.rstrip('/') + path, method=method, headers=headers,
        data=json.dumps(body).encode() if body is not None else None)
    with opener.open(request, timeout=60) as response: return json.load(response)
def clock():
    return json.loads(kube('exec', 'deployment/lab-target', '-c', 'telemetry', '--', 'node', '-e',
        'console.log(JSON.stringify({wallMs:Date.now(),monotonicMs:Number(process.hrtime.bigint()/1000000n)}))'))
def rows(campaign_id):
    result = []
    for line in kube('logs', 'deployment/lab-target', '-c', 'target', '--tail=500').splitlines():
        try: row = json.loads(line)
        except ValueError: continue
        if row.get('run', '').startswith(campaign_id + ':'): result.append(row)
    return result
def coordinator_state():
    """Replica count, live pod names and the Service's ready endpoint names."""
    deployment = json.loads(kube('get', 'deployment', 'lab-fleet', '-o', 'json'))
    replicas = deployment['spec']['replicas']
    pods = sorted(item['metadata']['name'] for item in
        json.loads(kube('get', 'pods', '-l', 'app=lab-fleet', '-o', 'json'))['items'])
    endpoints = []
    for subset in json.loads(kube('get', 'endpoints', 'lab-fleet', '-o', 'json')).get('subsets') or []:
        for address in subset.get('addresses') or []:
            name = (address.get('targetRef') or {}).get('name')
            if name: endpoints.append(name)
    return replicas, pods, sorted(endpoints)
def coordinator_restart_idle():
    """(B) Delete one IDLE coordinator pod and prove the Service stays available.

    Nothing generates load here. The assertions are that the ready endpoint list
    never drops below replicas-1 while the replacement starts, and that full
    readiness is restored so the run that follows starts against a healthy fleet.
    """
    replicas, pods, endpoints = coordinator_state()
    if not isinstance(replicas, int) or replicas < 2:
        raise RuntimeError('Coordinator restart requires at least two replicas')
    if len(pods) != replicas or len(endpoints) != replicas:
        raise RuntimeError('Coordinator inventory is not fully ready before restart')
    victim = pods[0]
    preserve('coordinator-restart-before.json', {'replicas': replicas, 'pods': pods,
        'endpoints': endpoints, 'pod': victim})
    kube('delete', 'pod', victim, '--wait=false')
    minimum = len(endpoints)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        current = coordinator_state()[2]
        minimum = min(minimum, len(current))
        if victim not in current and len(current) >= replicas - 1: break
        time.sleep(0.25)
    else:
        raise RuntimeError('Coordinator endpoints dropped below the tolerated loss')
    if minimum < replicas - 1:
        raise RuntimeError('Coordinator Service lost more than one endpoint')
    kube('rollout', 'status', 'deployment/lab-fleet', '--timeout=110s', timeout=125)
    ready = coordinator_state()[2]
    if len(ready) < replicas:
        raise RuntimeError('Coordinator did not return to full readiness after restart')
    evidence = {'pod': victim, 'replicas': replicas, 'endpointsBefore': len(endpoints),
        'endpointsMinimum': minimum, 'endpointsAfter': len(ready), 'runFollowsRestart': True}
    preserve('coordinator-restart.json', evidence)
    return evidence
token = call('POST', '/api/auth/login', {'email': 'abdelha@wedos', 'password': credentials['owner-password']})['token']
limits = call('GET', '/api/limits')['effective']
if not (3 <= limits['maxRps'] <= 15 and 3 <= limits['maxConcurrency'] <= 6 and 30 <= limits['maxDurationSec'] <= 60):
    raise RuntimeError('Private laboratory limits required')
# (B) runs before the campaign: the pod churn must not disturb the run that follows.
restart_evidence = None
if args.mode == 'coordinator-restart':
    restart_evidence = coordinator_restart_idle()
campaign = call('POST', '/api/campaigns', {'name': 'Private fleet manual stop',
    'target': 'http://lab-target:8080/health', 'probeUrl': 'http://lab-target:8080/health',
    'probeVantage': 'remote', 'vector': 'http-get', 'agent': 'fleet', 'maxRps': 3,
    'concurrency': 3, 'maxDurationSec': 30, 'authorized': True})
preserve('campaign.json', campaign)
with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
    future = executor.submit(call, 'POST', '/api/campaigns/' + campaign['id'] + '/execute', {'confirmed': True})
    deadline = time.monotonic() + 23
    while time.monotonic() < deadline:
        active = rows(campaign['id'])
        if len({row['source'] for row in active}) == 3: break
        if future.done(): raise RuntimeError('Run settled before three active sources were observed')
        time.sleep(0.5)
    else: raise RuntimeError('Three active sources not observed within the recipe window')
    anchor = clock()  # Target clock before dispatch: conservative elapsed upper bound.
    preserve('stop-anchor.json', anchor)
    restore = False
    restored_replicas = None
    restore_degraded = False
    restore_policy = None
    try:
        if args.mode == 'manual':
            acknowledgement = call('POST', '/api/campaigns/' + campaign['id'] + '/kill', {})
        elif args.mode == 'coordinator-outage':
            deployment = json.loads(kube('get', 'deployment', 'lab-fleet', '-o', 'json'))
            replicas = deployment['spec']['replicas']
            if not isinstance(replicas, int) or replicas < 1:
                raise RuntimeError('Coordinator replica count unavailable before outage')
            # This scenario removes the WHOLE coordination surface, not one pod:
            # while any replica survives the agents keep renewing their leases,
            # so a one-pod loss is an availability test with a different (and
            # non-deterministic) assertion. The replica count is preserved and
            # restored verbatim so the recipe works at 1 or 3 replicas.
            preserve('coordinator-before.json', {'uid': deployment['metadata']['uid'], 'replicas': replicas})
            restore = True  # Restore even if the API reply is lost after accepting scale.
            restored_replicas = replicas
            kube('scale', 'deployment/lab-fleet', '--replicas=0')
            acknowledgement = {'status': 'coordinator-scaled-to-zero', 'replicasBefore': replicas}
        elif args.mode == 'coordinator-degraded':
            # (A) Lose exactly ONE coordinator mid-run. The Service keeps the other
            # replicas, so this deliberately probes the fail-closed contract: an
            # agent that loses its heartbeat must stop rather than report a partial
            # measurement as success. Either outcome is accepted, but only those two.
            replicas, pods, endpoints = coordinator_state()
            if not isinstance(replicas, int) or replicas < 2:
                raise RuntimeError('Coordinator degradation requires at least two replicas')
            if len(pods) != replicas:
                raise RuntimeError('Coordinator inventory is not complete before degradation')
            victim = pods[0]
            restore_degraded = True
            kube('delete', 'pod', victim, '--wait=false')
            acknowledgement = {'status': 'coordinator-pod-deleted', 'pod': victim,
                'replicasBefore': replicas, 'endpointsBefore': len(endpoints)}
        elif args.mode == 'coordinator-restart':
            # The disruption already happened BEFORE dispatch (see above), against an
            # idle fleet; the following run must be completely unaffected.
            acknowledgement = {'status': 'coordinator-restarted-before-dispatch'}
        elif args.mode == 'control-crash':
            acknowledgement = json.loads(subprocess.check_output(['ssh', '-i', args.ssh_key,
                '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12',
                'root@31.31.74.187', 'python3 /usr/local/lib/ddostester-lab/linux-control-crash.py '
                '/var/lib/ddostester-linux-lab-attempt-03'], text=True, timeout=20))
            if acknowledgement.get('crashed') is not True: raise RuntimeError('Control crash not confirmed')
        elif args.mode == 'policy-removal':
            armed = json.loads(subprocess.check_output(['ssh', '-i', args.ssh_key,
                '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=12',
                'root@31.31.74.187', 'python3 /usr/local/lib/ddostester-lab/linux-policy-rollback.py '
                '/var/lib/ddostester-linux-lab-attempt-03 --arm --delay 60'], text=True, timeout=20))
            if armed.get('armed') is not True:
                raise RuntimeError('Host rollback was not armed; policy preserved')
            preserve('host-rollback.json', armed)
            policy = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
            expected = {'podSelector': {'matchLabels': {'app': 'lab-agent'}}, 'policyTypes': ['Egress'],
                'egress': [{'to': [{'podSelector': {'matchLabels': {'app': 'lab-fleet'}}}],
                    'ports': [{'protocol': 'TCP', 'port': 8443}]}]}
            if policy['spec'] != expected:
                raise RuntimeError('Existing coordinator policy differs; preserved without changes')
            restore_policy = {'apiVersion': policy['apiVersion'], 'kind': policy['kind'],
                'metadata': {key: value for key, value in policy['metadata'].items()
                    if key in {'name', 'namespace', 'labels', 'annotations'}}, 'spec': policy['spec']}
            preserve('policy-before.json', restore_policy)
            kube('delete', 'networkpolicy', 'agent-coordinator')
            acknowledgement = {'status': 'coordinator-egress-policy-removed',
                'limitation': 'Existing connection behavior depends on the CNI implementation'}
        preserve('stop-ack.json', acknowledgement)
        if args.mode == 'control-crash':
            try:
                future.result(timeout=20)
            except Exception as error:
                preserve('execute-interrupted.json', {'errorType': type(error).__name__})
            else:
                raise RuntimeError('Execution did not interrupt after control crash')
        else:
            # The stop scenarios settle almost immediately after the act at the
            # anchor, but a run that SURVIVES a single-replica loss (and any run
            # after an idle restart) completes its full maxDurationSec of 30 s.
            settle = 90 if args.mode in {'coordinator-degraded', 'coordinator-restart'} else 20
            result = future.result(timeout=settle)
            preserve('run.json', result)
        time.sleep(9)
        after = clock()
        receipts = rows(campaign['id'])
        preserve('target-receipts.json', receipts)
        preserve('after-anchor.json', after)
    finally:
        if restore:
            kube('scale', 'deployment/lab-fleet', '--replicas=' + str(restored_replicas))
            kube('rollout', 'status', 'deployment/lab-fleet', '--timeout=110s', timeout=125)
        if restore_degraded:
            kube('rollout', 'status', 'deployment/lab-fleet', '--timeout=110s', timeout=125)
            replicas_now, _, endpoints_now = coordinator_state()
            if len(endpoints_now) < replicas_now:
                raise RuntimeError('Coordinator did not recover to full readiness after degradation')
        if restore_policy:
            subprocess.run(['kubectl', '--kubeconfig', args.kubeconfig, '-n', 'ddostester-lab',
                '--server', server_override,
                'apply', '-f', '-'], input=json.dumps(restore_policy), text=True, check=True,
                capture_output=True, timeout=20)
            restored = json.loads(kube('get', 'networkpolicy', 'agent-coordinator', '-o', 'json'))
            if restored['spec'] != restore_policy['spec']:
                raise RuntimeError('Restored coordinator policy differs from original')
            preserve('policy-restored.json', {'restored': True, 'spec': restored['spec']})
    if args.mode == 'control-crash':
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            try:
                if call('GET', '/ready').get('ready') is True: break
            except Exception: pass
            time.sleep(0.5)
        else: raise RuntimeError('Control did not recover readiness')
        recovered = call('GET', '/api/campaigns/' + campaign['id'])
        fleet = call('GET', '/api/fleet/status')
        reports = call('GET', '/api/runs?campaignId=' + campaign['id'])
        preserve('campaign-recovered.json', recovered)
        preserve('fleet-recovered.json', fleet)
        preserve('reports-recovered.json', reports)
        drift = abs((after['wallMs'] - anchor['wallMs']) - (after['monotonicMs'] - anchor['monotonicMs']))
        if len({row['source'] for row in receipts}) != 3 or drift > 250:
            raise RuntimeError('Source or clock evidence missing after crash')
        signal_anchor = acknowledgement['signalAnchor']
        offset = signal_anchor['wallMs'] - signal_anchor['monotonicMs']
        clock_error = max(abs(offset - (clock_value['wallMs'] - clock_value['monotonicMs'])) for clock_value in [anchor, after])
        if clock_error > 250: raise RuntimeError('Host/target clock compatibility not proven')
        delay = max(0, max((row['epochSec'] - row['durationSec']) * 1000 for row in receipts) - signal_anchor['wallMs']) + clock_error
        if delay > 8000 or recovered['status'] != 'CANCELLED' or fleet.get('run', {}).get('state') == 'RUNNING':
            raise RuntimeError('Crash stop/reconciliation guarantee not proven')
        proof = {'scenario': 'control-crash', 'lastRequestAfterAnchorMs': round(delay),
            'anchor': 'host-before-signal', 'clockCompatibilityErrorMs': clock_error,
            'clockDriftMs': drift, 'sources': 3, 'campaignStatus': recovered['status'],
            'fleetState': fleet.get('run', {}).get('state'), 'finalizedReportCount': len(reports)}
        preserve('stop-proof.json', proof)
        print(json.dumps(proof))
        raise SystemExit(0)
    bundle = call('GET', '/api/runs/' + result['runId'] + '/fleet-evidence.json')
    preserve('fleet-evidence.json', bundle)
    subprocess.run(['node', '--input-type=module', '-e',
        'import fs from "node:fs";import {createHash} from "node:crypto";'
        'const b=JSON.parse(fs.readFileSync(0,"utf8"));'
        'if(createHash("sha256").update(JSON.stringify(b.content)).digest("hex")!==b.sha256)'
        'throw new Error("Evidence checksum mismatch");'],
        input=json.dumps(bundle),text=True,check=True,timeout=10)
    drift = abs((after['wallMs'] - anchor['wallMs']) - (after['monotonicMs'] - anchor['monotonicMs']))
    if drift > 250: raise RuntimeError('Target wall clock changed; stop timing is inconclusive')
    if len({row['source'] for row in receipts}) != 3:
        raise RuntimeError('Missing private source receipt evidence')
    last_start = max((row['epochSec'] - row['durationSec']) * 1000 for row in receipts)
    delay = max(0, last_start - anchor['wallMs'])
    fleet_result = result['generator']['fleet']
    shard_states = [shard['state'] for shard in fleet_result['shards']]
    # The 8 s bound is a STOP guarantee: it only means something when the act at
    # the anchor is expected to halt generation. A restart that precedes the run
    # stops nothing, and losing one replica may legitimately complete the run.
    stops_generation = args.mode in {'manual', 'coordinator-outage', 'policy-removal'} or (
        args.mode == 'coordinator-degraded' and fleet_result['measurementComplete'] is False)
    if stops_generation and delay > 8000:
        raise RuntimeError('Stop timing guarantee not proven; evidence retained')
    if args.mode == 'manual' and (acknowledgement.get('status') != 'KILLED_MANUAL' or result['status'] != 'KILLED_MANUAL'):
        raise RuntimeError('Manual stop status not proven; evidence retained')
    if args.mode in {'coordinator-outage', 'policy-removal'} and (
            fleet_result['measurementComplete'] is not False or 'LOST' not in shard_states):
        raise RuntimeError('Coordinator outage not represented as incomplete evidence')
    if args.mode == 'coordinator-degraded':
        # Exactly two acceptable outcomes, never a silent success on partial data:
        # a complete measurement with three SUCCEEDED shards, or an incomplete one
        # that names the shard which lost control.
        if fleet_result['measurementComplete'] is True:
            if any(state != 'SUCCEEDED' for state in shard_states):
                raise RuntimeError('Complete fleet measurement with a non-succeeded shard')
        elif not any(state in {'LOST', 'STOPPED', 'FAILED'} for state in shard_states):
            raise RuntimeError('Incomplete fleet measurement without an attributable shard')
    if args.mode == 'coordinator-restart' and fleet_result['measurementComplete'] is not True:
        raise RuntimeError('Idle coordinator restart disturbed the following run')
    proof = {'scenario': args.mode, 'runId': result['runId'], 'lastRequestAfterAnchorMs': round(delay),
        'observation': 'target-clock-before-dispatch-upper-bound', 'sources': len({row['source'] for row in receipts}),
        'clockDriftMs': drift, 'measurementComplete': fleet_result['measurementComplete'],
        'shardStates': shard_states}
    if restart_evidence: proof['coordinatorRestart'] = restart_evidence
    preserve('stop-proof.json', proof)
    print(json.dumps(proof))
