/**
 * Tiny cross-component channel for "AI support".
 *
 * An AI-support button on any card publishes that block's context here; the
 * docked assistant (and the full Assistant page) subscribe, open, and pre-load
 * the context into the composer so the user can start an interactive exchange.
 * Kept dependency-free so any module can publish without importing the chat.
 */
export interface AiSupportRequest {
  /** Short human label of the block, e.g. "Active alerts". */
  title: string;
  /** One-line factual summary of what the block currently shows. */
  context: string;
}

type Handler = (req: AiSupportRequest) => void;
const handlers = new Set<Handler>();

/** Subscribe to AI-support requests. Returns an unsubscribe function. */
export function onAiSupport(h: Handler): () => void {
  handlers.add(h);
  return () => {
    handlers.delete(h);
  };
}

/** Publish an AI-support request to every current subscriber. */
export function requestAiSupport(req: AiSupportRequest): void {
  handlers.forEach((h) => h(req));
}
