# Notifications

The control plane can push a short message to your team when something worth
knowing happens. Notifications are **opt-in**: with no sink configured, nothing
is sent.

## Events

| Event                | When                                                                                                              | Severity           |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------ |
| `campaign.completed` | a run finished normally                                                                                           | info               |
| `campaign.killed`    | a run hit the kill switch (auto or manual)                                                                        | critical / warning |
| `wrs.regression`     | a target's WRS dropped > 10 points vs. the last run                                                               | warning            |
| `baseline.drift`     | a target's nominal baseline degraded vs. the previous run (availability −≥5 pts, or p95 latency +≥25% and ≥20 ms) | warning            |

Each notification carries the campaign name, target, engine, WRS score and
level, request/failure counts and probe availability.

## Sinks

Two sink types, either or both:

- **Slack** — an [incoming webhook](https://api.slack.com/messaging/webhooks).
  The message is posted with a coloured attachment (green/amber/red by severity).
- **Generic webhook** — any HTTPS endpoint that accepts a JSON `POST`. The body
  is the raw event: `{ product, kind, severity, title, text, at, campaignId, fields }`.

Only `http`/`https` URLs are accepted. Delivery is best-effort and time-boxed
(5 s): a failing or slow sink is logged, never propagated, so it can't disrupt a
campaign.

## Configuration

Set these environment variables on the server (see `.env.example`):

```bash
# Slack incoming webhook
NOTIFY_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ
# Generic JSON webhook
NOTIFY_WEBHOOK_URL=https://example.internal/shieldtest-hook
# Optional: restrict which events are sent (comma-separated). Default: all.
NOTIFY_EVENTS=campaign.killed,wrs.regression
# Optional: per-request timeout in ms (default 5000).
NOTIFY_TIMEOUT_MS=5000
```

Restart the service after changing them. On startup the log line shows the
active sinks (`notifications: slack+webhook`), and `GET /health` returns
`notifications: ["slack","webhook"]` (sink **names** only — never the URLs).

## Verifying

In the UI: **Settings → Notifications** shows the configured sinks and, for
users who can create campaigns, a **Send test notification** button.

By API:

```bash
curl -fsS -X POST localhost:8080/api/notify/test \
  -H "authorization: Bearer <token>"      # required only when auth is enabled
# → {"delivered":true,"sinks":["slack"]}
```

## Security notes

- Outbound only: the server dials the configured sink; nothing is opened inbound.
- URLs live in the environment, never in the database, and are never exposed by
  the API or the UI (only sink names are).
- Notifications are unrelated to the target allowlist — the sink is your own
  Slack/endpoint, not a load target.
