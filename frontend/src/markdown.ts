/**
 * markdown.ts — minimal, dependency-free, XSS-safe Markdown → HTML for assistant
 * replies. Every character of the source is HTML-escaped BEFORE any tag is
 * inserted, so model output can never inject markup. Supports the subset the
 * Qwen copilot actually emits: fenced code blocks (```lang), inline `code`,
 * **bold**, *italic*, #.. headings, -/* and 1. lists, > blockquotes, https
 * links, and paragraphs.
 *
 * SAFETY: designed for dangerouslySetInnerHTML. Keep the escape-first
 * invariant — never emit raw source HTML, and only ever build https anchors.
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Inline formatting on already-escaped text. */
function inline(escaped: string): string {
  // Protect inline code spans so bold/italic/link never touch their contents.
  const spans: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    spans.push(`<code class="md-code">${c}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  // Links: only https(s), URL is constrained (no spaces or ")"), so attribute-safe.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Restore inline code.
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]);
  return s;
}

/** Block-level rendering for a non-code segment. */
function renderBlocks(seg: string): string {
  const lines = seg.split('\n');
  const html: string[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length) {
      html.push(`<p>${inline(escapeHtml(para.join(' ')))}</p>`);
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      flush();
      i++;
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush();
      const lvl = h[1].length;
      html.push(`<h${lvl} class="md-h">${inline(escapeHtml(h[2]))}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const q: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        q.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote class="md-quote">${inline(escapeHtml(q.join(' ')))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      html.push(
        `<ul class="md-ul">${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</ul>`,
      );
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flush();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      html.push(
        `<ol class="md-ol">${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</ol>`,
      );
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return html.join('');
}

/** Render a Markdown string to safe HTML. */
export function renderMarkdown(src: string): string {
  if (!src) return '';
  const text = src.replace(/\r\n/g, '\n');
  const out: string[] = [];
  // Split out fenced code blocks first (kept verbatim, escaped, no inline pass).
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^```[\s\S]*```$/.test(part)) {
      const m = part.match(/^```([^\n`]*)\n?([\s\S]*?)```$/);
      const lang = (m?.[1] || '').trim();
      const code = escapeHtml(m?.[2] ?? '').replace(/\n$/, '');
      out.push(
        `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${code}</code></pre>`,
      );
      continue;
    }
    out.push(renderBlocks(part));
  }
  return out.join('');
}
