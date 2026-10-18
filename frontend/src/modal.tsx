import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = ref.current!;
    const controls = () =>
      [
        ...dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]',
        ),
      ].filter((el) => el.tabIndex >= 0 && !el.hasAttribute('disabled') && !el.closest('[hidden]'));
    (controls().find((el) => !el.closest('.help-tip')) ?? dialog).focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = controls();
      const first = items[0] ?? dialog;
      const last = items.at(-1) ?? dialog;
      if (
        !items.length ||
        !dialog.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    };
    dialog.addEventListener('keydown', trap);
    return () => {
      document.body.style.overflow = overflow;
      dialog.removeEventListener('keydown', trap);
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div className="overlay" onClick={onClose}>
      <div
        className={`modal${className ? ` ${className}` : ''}`}
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
