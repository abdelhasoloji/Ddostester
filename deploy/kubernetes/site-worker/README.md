# Remote site worker (`ac02`)

A site runs **one** resident worker. It dials the coordinator outbound over mTLS,
claims the shard planned for its certificate identity, executes it with the bounded
engine and reports the outcome. It listens on nothing and holds no cluster
credentials.

This directory is deliberately **not** part of any kustomization: `worker.template.yaml`
contains `${VAR}` placeholders and must not be applied as-is.

```
cp site.env.example site.env      # edit every CHANGE_ME and every value
node check-render.mjs site.env    # offline: catches placeholders and bad values
set -a; . ./site.env; set +a
envsubst < worker.template.yaml | kubectl apply -f -
```

`envsubst` comes from gettext (`brew install gettext` on macOS). If you do not have
it, substitute with Python:

```
python3 - <<'PY' > /tmp/worker.yaml
import os, re, pathlib
text = pathlib.Path('worker.template.yaml').read_text()
print(re.sub(r'\$\{([A-Z0-9_]+)\}', lambda m: os.environ[m.group(1)], text), end='')
PY
kubectl apply -f /tmp/worker.yaml
```

## 1. Publish the image (blocker n°5)

The lab builds locally (`ddostester-lab-control:local`, `imagePullPolicy: Never`).
A remote cluster needs a registry. The script does the build, push and digest
lookup, and can write the result straight into `site.env`:

```
export GHCR_USER=<your-github-user>
export GHCR_TOKEN=<PAT with write:packages>
./scripts/operations/build-and-push-image.sh --write-env deploy/kubernetes/site-worker/site.env
```

It builds with `--platform linux/amd64` by default (Apple Silicon host, amd64
site), passes the commit and tag build-args, feeds the token to `docker login` on
stdin only, prints `FLEET_WORKER_IMAGE=<digest>` and refuses a reference that is
not digest-pinned. `--dry-run` prints the exact commands without touching Docker;
`--platform` and `--tag` override the defaults.

Notes:

- Build from the repository root: the Dockerfile copies `backend/`, `frontend/`,
  `standards/` and `scripts/`.
- Use the **digest**: a tag can be repointed, and the fleet policy is written in
  terms of immutable references.
- This image is for the *worker*. The coordinator's own `FLEET_AGENT_IMAGE` (used
  to create local Jobs) is validated against the local registry pattern and does
  not need to change for a remote site.

## 2. Identity

```
kubectl -n "$SITE_NAMESPACE" create secret generic "$FLEET_IDENTITY_SECRET" \
  --from-file=tls.key=<three.key> --from-file=tls.crt=<three.crt> --from-file=ca.crt=<ca.crt>
```

CN must equal `FLEET_AGENT_ID`. Keys stay out of Git. The leaf lasts 14 days and
renewal is manual; the coordinator reports `expiring` at 7 days in
`/api/fleet/status`.

## 3. Reachability and the SAN

WireGuard is the recommended path (private addresses, no public surface):

| Node | WireGuard address | Role |
| --- | --- | --- |
| amplification VPS | `10.8.0.1` | coordinator `:8443` |
| ac02 | `10.8.0.2` | worker |

The coordinator certificate must carry the **exact host** used in
`FLEET_CONTROL_URL`. Re-issue it from the existing CA (the script preserves every
SAN already present, verifies the new leaf and leaves the current certificate in
place):

```
./scripts/operations/generate-ac02-cert.sh --pki <pki-dir> --san-ip 10.8.0.1
```

It then prints the `kubectl create secret generic fleet-server ... --dry-run=client
-o yaml | kubectl apply -f -` command. Requirements:

- URL by IP → SAN entry `IP:10.8.0.1` (an IP in a `DNS:` entry is **not** valid and
  the client will reject the certificate);
- URL by name → SAN entry `DNS:fleet.example.com`.

Verify before deploying:

```
openssl x509 -in server.crt -noout -ext subjectAltName
```

Then register the agent in the shared registry the control plane and the fleet
server both read (the `fleet-registry` ConfigMap):

```
FLEET_SITES=one@vps-lab,two@vps-lab,three@ac02
FLEET_LOCAL_SITE=vps-lab
```

`FLEET_LOCAL_SITE` is what stops the control plane from creating a local Job for
`three`: a local Job would race the remote claim and, `claim` being atomic, the
remote worker would silently never emit traffic.

## 4. Validate the render offline

`kubectl apply --dry-run=client` still performs API discovery, so it needs a
reachable cluster. Validate the substitution **before** that, with no cluster and
no Docker:

```
node check-render.mjs site.env
```

It fails on an unfilled `CHANGE_ME`, a missing value, invalid YAML, a tag instead
of a digest, a policy above `HARD_CAPS`, more than one replica, a writable root
filesystem, or an ingress rule — and prints the exact `FLEET_SITES` entry the
coordinator needs.

## 5. After deployment

1. `kubectl -n "$SITE_NAMESPACE" logs deploy/fleet-worker` shows one poll per
   interval and no TLS error.
2. `/api/fleet/status` lists `three` with `site: "ac02"` and a certificate status of
   `ok`/`expiring`.
3. A planned run assigns the shard; the worker executes it; the run's
   `fleet.shards` carry `site: "ac02"`.
4. Negative checks: unregistered CN → 403; revoked leaf → 403; a second worker with
   the same CN gets no work (the shard is already `RUNNING`).

## Pitfalls

- **`CHANGE_ME` left in `site.env`** → the Deployment is created with an
  unpullable image. Grep for it before applying.
- **Architecture mismatch** → `ImagePull` succeeds, the container exits with
  `exec format error`. Build with `--platform linux/amd64` if ac02 is amd64.
- **No probe**: the worker has no listening port, so Kubernetes only restarts it on
  process exit. A hung poll is bounded by the 2 s request timeout and the loop's
  consecutive-failure counter.
- **Two workers, one CN** → one gets the shard, the other idles. Keep
  `replicas: 1`.
