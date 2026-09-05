import type { LoadProgress } from '../engine/loadTest.js';

/** Live progress of a running campaign (real-time, CAM-04). */
export interface LiveProgress extends LoadProgress {
  maxDurationSec: number;
  status: 'RUNNING';
  /** Active load engine name (e.g. 'k6', 'builtin-http'). */
  engine?: string;
}

const live = new Map<string, LiveProgress>();

export const liveProgress = {
  set: (campaignId: string, p: LiveProgress): void => void live.set(campaignId, p),
  get: (campaignId: string): LiveProgress | undefined => live.get(campaignId),
  clear: (campaignId: string): void => void live.delete(campaignId),
};
