import { LineIcon } from './interface-kit.js';
import { hostOf } from './campaign-form.js';
import { defaultTargetUrl } from './target-url.js';

/**
 * The shared target picker used across the launch flow (recon-first create and
 * the Templates tab): a focus-within bar with an outline leading icon, an inline
 * allowlist ✓ once the host is on the allowlist, and the allowlist rendered as
 * clickable ◎ host chips (active host highlighted). Extracted so the two call
 * sites can't drift. It renders ONLY the bar + chips — the caller keeps its own
 * label and any invalid-hint copy. Exactly one text input, so tests that query
 * `getByRole('textbox')` are unaffected.
 */
export function TargetBar({
  target,
  onChange,
  allowed,
  placeholder,
  onEnter,
}: {
  target: string;
  onChange: (value: string) => void;
  allowed: string[];
  placeholder?: string;
  /** Called on Enter in the input (e.g. run recon). Omit for no keyboard action. */
  onEnter?: () => void;
}) {
  const host = hostOf(target);
  const isAllowed = host !== null && allowed.includes(host);
  return (
    <>
      <div className={`recon-target-bar${target && !isAllowed ? ' invalid' : ''}`}>
        <span className="recon-target-icon" aria-hidden="true">
          <LineIcon name="shield" />
        </span>
        <input
          className="recon-target-url"
          value={target}
          placeholder={placeholder ?? 'https://…'}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={
            onEnter
              ? (e) => {
                  if (e.key === 'Enter') onEnter();
                }
              : undefined
          }
        />
        {isAllowed && (
          <span className="recon-target-ok" title="On the allowlist" aria-label="allowed">
            ✓
          </span>
        )}
      </div>
      {allowed.length > 0 && (
        <div className="recon-allowed">
          <span className="recon-allowed-label">Allowed</span>
          {allowed.map((h) => (
            <button
              key={h}
              type="button"
              className={`recon-host-chip${host === h ? ' on' : ''}`}
              onClick={() => onChange(defaultTargetUrl(h))}
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
