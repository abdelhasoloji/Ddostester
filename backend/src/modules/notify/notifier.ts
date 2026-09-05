import { genericPayload, slackPayload } from './events.js';
import { NOTIFICATION_KINDS } from './types.js';
import type { NotificationEvent, NotificationKind, Notifier } from './types.js';

export interface NotifyConfig {
  /** Generic JSON webhook (a POST of the event payload). */
  webhookUrl?: string;
  /** Slack incoming webhook. */
  slackUrl?: string;
  /** Which event kinds to deliver (default: all). */
  events?: NotificationKind[];
  /** Per-request timeout in ms (default 5000). */
  timeoutMs?: number;
}

/** A logger sink for delivery failures (never throws into the caller). */
type Log = (msg: string, err: unknown) => void;

/** Reads the notification configuration from the environment. */
export function notifyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyConfig {
  const events = (env.NOTIFY_EVENTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is NotificationKind => (NOTIFICATION_KINDS as string[]).includes(s));
  return {
    webhookUrl: env.NOTIFY_WEBHOOK_URL?.trim() || undefined,
    slackUrl: env.NOTIFY_SLACK_WEBHOOK_URL?.trim() || undefined,
    events: events.length ? events : undefined,
    timeoutMs: env.NOTIFY_TIMEOUT_MS ? Number(env.NOTIFY_TIMEOUT_MS) : undefined,
  };
}

/** A notifier that delivers nothing (no sink configured). */
export const noopNotifier: Notifier = {
  sinks: [],
  events: NOTIFICATION_KINDS,
  async notify() {
    /* no-op */
  },
};

/**
 * Posts JSON to a URL with a timeout. Only http/https are accepted. Injected in
 * tests so delivery can be verified without the network.
 */
export type PostFn = (url: string, payload: unknown, timeoutMs: number) => Promise<void>;

const fetchPost: PostFn = async (url, payload, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-wedos-shieldtest': 'notification' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`sink responded ${res.status}`);
    await res.arrayBuffer().catch(() => undefined);
  } finally {
    clearTimeout(timer);
  }
};

class HttpNotifier implements Notifier {
  readonly sinks: readonly string[];
  readonly events: readonly NotificationKind[];
  private readonly timeoutMs: number;

  constructor(
    private readonly cfg: NotifyConfig,
    private readonly post: PostFn = fetchPost,
    private readonly log: Log = () => {},
  ) {
    const sinks: string[] = [];
    if (cfg.slackUrl) sinks.push('slack');
    if (cfg.webhookUrl) sinks.push('webhook');
    this.sinks = sinks;
    this.events = cfg.events ?? NOTIFICATION_KINDS;
    this.timeoutMs = cfg.timeoutMs ?? 5000;
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (!this.events.includes(event.kind)) return;
    const jobs: Promise<void>[] = [];
    if (this.cfg.slackUrl) {
      jobs.push(
        this.post(this.cfg.slackUrl, slackPayload(event), this.timeoutMs).catch((err) =>
          this.log('notify: slack delivery failed', err),
        ),
      );
    }
    if (this.cfg.webhookUrl) {
      jobs.push(
        this.post(this.cfg.webhookUrl, genericPayload(event), this.timeoutMs).catch((err) =>
          this.log('notify: webhook delivery failed', err),
        ),
      );
    }
    await Promise.all(jobs);
  }
}

/**
 * Builds a notifier from config. Returns the no-op notifier when no sink is
 * configured, so notifications are strictly opt-in.
 */
export function createNotifier(cfg: NotifyConfig, post?: PostFn, log?: Log): Notifier {
  if (!cfg.webhookUrl && !cfg.slackUrl) return noopNotifier;
  const validate = (url: string, name: string): void => {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`NOTIFY: invalid ${name} URL`);
    }
    if (!['http:', 'https:'].includes(u.protocol)) {
      throw new Error(`NOTIFY: ${name} URL must be http or https`);
    }
  };
  if (cfg.slackUrl) validate(cfg.slackUrl, 'Slack');
  if (cfg.webhookUrl) validate(cfg.webhookUrl, 'webhook');
  return new HttpNotifier(cfg, post, log);
}
