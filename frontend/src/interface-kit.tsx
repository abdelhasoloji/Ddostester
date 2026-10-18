import { useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export function HelpTip({ text, label = 'More information' }: { text: string; label?: string }) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const b = bubble.current?.getBoundingClientRect();
      if (!a || !b) return;
      setPosition({
        left: Math.max(8, Math.min(a.right - b.width, window.innerWidth - b.width - 8)),
        top: Math.max(
          8,
          a.bottom + b.height + 16 > window.innerHeight ? a.top - b.height - 8 : a.bottom + 8,
        ),
      });
    };
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopImmediatePropagation();
        setOpen(false);
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('keydown', dismiss, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('keydown', dismiss, true);
    };
  }, [open, text]);
  return (
    <span
      className="help-tip"
      ref={anchor}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        ?
      </button>
      {open &&
        createPortal(
          <span ref={bubble} className="help-tooltip" id={id} role="tooltip" style={position}>
            {text}
          </span>,
          document.body,
        )}
    </span>
  );
}

const paths = {
  home: 'M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9',
  shield: 'M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6Z',
  campaigns: 'M4 5h16v15H4ZM8 3v4m8-4v4M4 10h16M8 14h3m-3 3h7',
  fleet: 'M3 4h7v6H3Zm11 0h7v6h-7ZM8 15h8v6H8ZM6 10v3h12v-3m-6 3v2',
  theater: 'M3 4h18v13H3Zm6 17h6m-3-4v4M10 8l5 3-5 3Z',
  results: 'M5 3h10l4 4v14H5ZM9 16v-3m3 3V9m3 7v-5',
  chat: 'M4 4h16v12H9l-5 4Z',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6',
  sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  moon: 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11',
} as const;
export function LineIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="line-icon"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
