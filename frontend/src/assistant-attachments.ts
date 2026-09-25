/**
 * assistant-attachments.ts — client-side handling of file attachments for the
 * assistant chat.
 *
 * The assistant backend proxies to a TEXT-ONLY LLM (Qwen via llama.cpp), whose
 * message content is a plain string. So an attachment contributes to a turn by
 * having its TEXT extracted in the browser and folded into the user message —
 * never as a binary payload. Text-like files (logs, config, CSV, JSON, code, …)
 * are read directly; anything binary (or an image) is attached as a short
 * name/type note instead, since the model cannot interpret its bytes. Image
 * interpretation (screenshots) is intentionally deferred — flagged, not read.
 *
 * Everything is bounded: a per-file character cap and a total cap keep a large
 * paste from blowing the prompt/context. No network, no new dependency.
 */

export interface Attachment {
  id: string;
  name: string;
  /** MIME type (or a guess from the extension), for display + the prompt note. */
  type: string;
  size: number;
  /** Extracted text, when extraction succeeded. */
  text?: string;
  /** True when `text` was cut at the per-file cap. */
  truncated?: boolean;
  /** Why no text is present (binary / image / unreadable), for display + note. */
  note?: string;
}

export const PER_FILE_CHAR_CAP = 20_000;
export const TOTAL_CHAR_CAP = 60_000;
export const MAX_FILES = 6;

/** Extensions we read as UTF-8 text (in addition to any `text/*` MIME type). */
const TEXT_EXT = new Set([
  'txt',
  'log',
  'md',
  'markdown',
  'rst',
  'json',
  'jsonl',
  'ndjson',
  'csv',
  'tsv',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'py',
  'sh',
  'bash',
  'zsh',
  'ini',
  'conf',
  'cfg',
  'env',
  'toml',
  'sql',
  'java',
  'go',
  'rs',
  'rb',
  'php',
  'c',
  'h',
  'cpp',
  'hpp',
  'cc',
  'cs',
  'kt',
  'kts',
  'swift',
  'pl',
  'ps1',
  'properties',
  'gradle',
  'tf',
  'hcl',
  'diff',
  'patch',
  'srt',
  'vtt',
  'gitignore',
  'dockerfile',
  'makefile',
]);
const TEXT_MIME = new Set([
  'application/json',
  'application/xml',
  'application/x-yaml',
  'application/yaml',
  'application/x-sh',
  'application/javascript',
  'application/typescript',
  'application/csv',
  'application/x-ndjson',
]);

function ext(name: string): string {
  const base = name.toLowerCase().split('/').pop() ?? name.toLowerCase();
  if (!base.includes('.')) return base; // e.g. "Dockerfile", "Makefile"
  return base.slice(base.lastIndexOf('.') + 1);
}

export function isImage(file: { type?: string; name: string }): boolean {
  if (file.type && file.type.startsWith('image/')) return true;
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'heic', 'tiff'].includes(
    ext(file.name),
  );
}

export function isTextLike(file: { type?: string; name: string }): boolean {
  if (file.type && file.type.startsWith('text/')) return true;
  if (file.type && TEXT_MIME.has(file.type)) return true;
  return TEXT_EXT.has(ext(file.name));
}

/** A rough type label when the browser gives no MIME type. */
function guessType(name: string): string {
  const e = ext(name);
  if (TEXT_EXT.has(e)) return `text/${e}`;
  return 'application/octet-stream';
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function uid(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* fall through */
  }
  return `att_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Reads one file into an Attachment. Text-like → UTF-8 text (capped per file).
 * Image → a deferred-interpretation note. Anything else → a binary note. Never
 * throws: a read failure becomes a note.
 */
export async function readAttachment(file: File): Promise<Attachment> {
  const base: Attachment = {
    id: uid(),
    name: file.name || 'fichier',
    type: file.type || guessType(file.name),
    size: file.size,
  };
  if (isImage(file)) {
    return { ...base, note: "image — non interprétée par l'assistant (à venir)" };
  }
  if (isTextLike(file)) {
    try {
      const raw = await file.text();
      const truncated = raw.length > PER_FILE_CHAR_CAP;
      return { ...base, text: truncated ? raw.slice(0, PER_FILE_CHAR_CAP) : raw, truncated };
    } catch {
      return { ...base, note: 'contenu illisible' };
    }
  }
  return { ...base, note: 'contenu non extrait (format binaire)' };
}

/**
 * Folds attachments into the block appended to the user message sent to the
 * model. Enforces the total character cap across all files (each file's text is
 * already per-file capped by readAttachment). Returns '' for no attachments.
 */
export function attachmentsToPromptBlock(atts: Attachment[]): string {
  if (!atts.length) return '';
  let remaining = TOTAL_CHAR_CAP;
  const parts = atts.map((a) => {
    const header = `[Fichier: ${a.name} · ${a.type || 'type inconnu'} · ${formatSize(a.size)}${
      a.note ? ` — ${a.note}` : ''
    }]`;
    if (!a.text || remaining <= 0) return header;
    let body = a.text;
    let truncated = a.truncated ?? false;
    if (body.length > remaining) {
      body = body.slice(0, remaining);
      truncated = true;
    }
    remaining -= body.length;
    return `${header}\n${body}${truncated ? '\n[…tronqué]' : ''}`;
  });
  return `\n\n--- Pièces jointes ---\n${parts.join('\n\n')}`;
}
