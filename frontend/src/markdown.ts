/**
 * markdown.ts — minimal, dependency-free, XSS-safe Markdown → HTML for assistant
 * replies. Every character of the source is HTML-escaped BEFORE any tag is
 * inserted, so model output can never inject markup. Supports the subset the
 * Qwen copilot actually emits: fenced code blocks (```lang) with a copy button,
 * inline `code`, **bold**, *italic*, #.. headings, -/* and 1. lists,
 * > blockquotes, GitHub-style tables, https links, and paragraphs.
 *
 * SAFETY: designed for dangerouslySetInnerHTML. Keep the escape-first
 * invariant — never emit raw source HTML, and only ever build https anchors.
 * The only interactive element emitted is our own <button class="md-copy">,
 * which the page wires up by delegation (it carries no source-derived data).
 */

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Inline formatting on already-escaped text. */
function inline(escaped: string): string {
  const spans: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_m, c: string) => {
    spans.push(`<code class="md-code">${c}</code>`);
    return `\u0000${spans.length - 1}\u0000`;
  });
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) =>
      `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => spans[Number(i)]);
  return s;
}

/** Split a `| a | b |` row into trimmed cell strings. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** A `|---|:--:|` separator row. */
function isTableSep(line: string): boolean {
  return line.includes('-') && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(line);
}

function alignOf(cell: string): string {
  const l = cell.startsWith(':');
  const r = cell.endsWith(':');
  if (l && r) return 'center';
  if (r) return 'right';
  if (l) return 'left';
  return '';
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
    // GitHub-style table: a header row followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      flush();
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map(alignOf);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        body.push(tableCells(lines[i]));
        i++;
      }
      const cell = (t: string, tag: 'th' | 'td', idx: number): string => {
        const a = aligns[idx];
        return `<${tag}${a ? ` style="text-align:${a}"` : ''}>${inline(escapeHtml(t))}</${tag}>`;
      };
      const thead = `<thead><tr>${header.map((t, k) => cell(t, 'th', k)).join('')}</tr></thead>`;
      const tbody = `<tbody>${body
        .map((r) => `<tr>${r.map((t, k) => cell(t, 'td', k)).join('')}</tr>`)
        .join('')}</tbody>`;
      html.push(`<div class="md-tablewrap"><table class="md-table">${thead}${tbody}</table></div>`);
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
  const parts = text.split(/(```[\s\S]*?```)/g);
  for (const part of parts) {
    if (!part) continue;
    if (/^```[\s\S]*```$/.test(part)) {
      const m = part.match(/^```([^\n`]*)\n?([\s\S]*?)```$/);
      const lang = (m?.[1] || '').trim();
      const code = escapeHtml(m?.[2] ?? '').replace(/\n$/, '');
      out.push(
        `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}>` +
          `<button type="button" class="md-copy" aria-label="Copy code">Copy</button>` +
          `<code>${code}</code></pre>`,
      );
      continue;
    }
    out.push(renderBlocks(part));
  }
  return out.join('');
}
