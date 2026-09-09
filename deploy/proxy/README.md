# mTLS reverse proxy (public VPS)

Puts a TLS **+ mutual-TLS** reverse proxy in front of the control plane so only
clients bearing a certificate signed by our internal CA can reach it. The API
itself stays on **loopback** (`HOST=127.0.0.1`) — the proxy is the only way in.

## 1. Generate the PKI (on a secure workstation, not the VPS)

```bash
SERVER_CN=<vps-domain-or-public-ip> CLIENTS="alice bob" \
  bash deploy/proxy/make-ca-certs.sh
```

This writes `./shieldtest-pki/` (gitignored):

- **VPS** ← `server.crt`, `server.key`, `ca.crt`
- **each admin** ← `client-<name>.p12` (import into the browser / OS keychain)
- **keep offline** ← `ca.key` (never copy it to the VPS)

## 2. Place the certs + Caddyfile on the VPS

```bash
install -d -m 700 /etc/shieldtest/tls
# copy server.crt, server.key, ca.crt into /etc/shieldtest/tls/ (scp)
chmod 600 /etc/shieldtest/tls/*
install -Dm644 deploy/proxy/Caddyfile /etc/caddy/Caddyfile
# Caddy env (systemd drop-in or /etc/default/caddy):
#   SHIELDTEST_DOMAIN=<vps-domain-or-public-ip>
#   SHIELDTEST_UPSTREAM=127.0.0.1:8080
systemctl reload caddy   # or: caddy reload --config /etc/caddy/Caddyfile
```

The app must stay on loopback — do **not** set `ALLOW_PUBLIC_BIND`; keep
`HOST=127.0.0.1` in `/etc/ddostester.env`.

## 3. Firewall (defense in depth on top of mTLS)

Only the proxy port and admin SSH are open; the app port is never exposed.

```bash
# nftables (adjust <ADMIN_CIDR>):
nft add rule inet filter input tcp dport 443 ip saddr <ADMIN_CIDR> accept
nft add rule inet filter input tcp dport 22  ip saddr <ADMIN_CIDR> accept
nft add rule inet filter input tcp dport 8080 drop    # app: loopback only anyway
# default policy: drop
```

(ufw equivalent: `ufw allow from <ADMIN_CIDR> to any port 443,22 proto tcp` then
`ufw default deny incoming`.)

## 4. Verify

```bash
# No client cert → refused by the proxy:
curl -k https://<host>/health            # → TLS handshake / 403, denied
# With the client cert → reaches the API:
curl --cert client-alice.crt --key client-alice.key --cacert ca.crt \
  https://<host>/health                  # → {"status":"ok", "version":...}
```

The browser prompts for the client certificate once the `.p12` is imported.

## nginx alternative (built-in rate limiting)

```nginx
limit_req_zone $binary_remote_addr zone=st:10m rate=20r/s;
server {
  listen 443 ssl;
  server_name <host>;
  ssl_certificate     /etc/shieldtest/tls/server.crt;
  ssl_certificate_key /etc/shieldtest/tls/server.key;
  ssl_client_certificate /etc/shieldtest/tls/ca.crt;
  ssl_verify_client on;                 # mTLS: required
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains";
  location / {
    limit_req zone=st burst=40 nodelay;
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
  }
}
```

Caddy has no core rate limiter; add the `caddy-ratelimit` plugin, or rely on the
app's login lockout + fail2ban on the proxy access log if you stay on Caddy.
