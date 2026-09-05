/**
 * Notifications (adoption / operability): push a short message to the team when
 * something worth knowing happens — a campaign finished, a run was killed, or a
 * target's resilience score regressed. Delivery is outbound-only to an
 * operator-configured sink (a generic JSON webhook and/or a Slack incoming
 * webhook); it never generates load and is unrelated to the target allowlist.
 */

/** The events the control plane can emit. */
export type NotificationKind = 'campaign.completed' | 'campaign.killed' | 'wrs.regression';

export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'campaign.completed',
  'campaign.killed',
  'wrs.regression',
];

export type Severity = 'info' | 'warning' | 'critical';

/** A single labelled metric shown alongside a notification. */
export interface NotificationField {
  label: string;
  value: string;
}

/** A ready-to-format notification, independent of any sink. */
export interface NotificationEvent {
  kind: NotificationKind;
  severity: Severity;
  title: string;
  text: string;
  at: string; // ISO
  campaignId?: string;
  fields: NotificationField[];
}

/**
 * Delivers notifications to the configured sinks. Implementations must never
 * throw into the caller: a failing sink is logged, not propagated, so a broken
 * webhook can't break a campaign run.
 */
export interface Notifier {
  /** Human-readable names of the configured sinks (e.g. ['slack', 'webhook']). */
  readonly sinks: readonly string[];
  /** The event kinds this notifier will actually deliver. */
  readonly events: readonly NotificationKind[];
  notify(event: NotificationEvent): Promise<void>;
}
