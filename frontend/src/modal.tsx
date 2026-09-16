import { useEffect } from 'react';
import type { ReactNode } from 'react';

/** Close the active dialog on Escape. Bound only while `active` is true. */
export function useEscape(active: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);
}

/**
 * The one modal-dialog primitive: a dimmed overlay that closes on click-out and
 * on Escape, wrapping a focus-labelled `role="dialog"` box that swallows inner
 * clicks. Every dialog in the app renders through this so the a11y scaffolding
 * (aria-modal, Escape, overlay-dismiss) can never drift between them. Callers
 * mount it only when open (`{open && <Modal…>}`), so it is always active while
 * mounted; pass extra `.modal` classes via `className`.
 */
export function Modal({
  label,
  onClose,
  className,
  children,
}: {
  /** Accessible name for the dialog (aria-label). */
  label: string;
  /** Dismiss handler — fired by the overlay click and by Escape. */
  onClose: () => void;
  /** Extra classes appended to the inner `.modal` box. */
  className?: string;
  children: ReactNode;
}) {
  useEscape(true, onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div
        className={`modal${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
