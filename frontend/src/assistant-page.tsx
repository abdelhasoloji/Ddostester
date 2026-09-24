import { PageHead } from './pages.js';
import { AssistantChat } from './assistant-chat.js';

/**
 * Assistant full-page route. The chat itself lives in the reusable
 * <AssistantChat> component, which is also mounted as an always-on docked column
 * in the app shell (see Layout). This page is the expanded, full-width view.
 */
export function AssistantPage() {
  return (
    <div className="assistant-page">
      <PageHead
        title="Assistant"
        sub="Conversational copilot — it reasons and runs actions inline, through governance: approval, HARD_CAPS and the kill switch still apply."
      />
      <AssistantChat variant="page" />
    </div>
  );
}
