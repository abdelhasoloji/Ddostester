import { describe, it, expect } from 'vitest';
import {
  readAttachment,
  attachmentsToPromptBlock,
  isImage,
  isTextLike,
  formatSize,
  PER_FILE_CHAR_CAP,
  TOTAL_CHAR_CAP,
  type Attachment,
} from './assistant-attachments.js';

const file = (content: string, name: string, type = ''): File =>
  new File([content], name, { type });

describe('isTextLike / isImage', () => {
  it('recognises text by MIME and by extension', () => {
    expect(isTextLike({ type: 'text/plain', name: 'a.txt' })).toBe(true);
    expect(isTextLike({ type: '', name: 'server.log' })).toBe(true);
    expect(isTextLike({ type: '', name: 'data.json' })).toBe(true);
    expect(isTextLike({ type: '', name: 'Dockerfile' })).toBe(true);
    expect(isTextLike({ type: '', name: 'archive.zip' })).toBe(false);
  });
  it('recognises images by MIME and by extension', () => {
    expect(isImage({ type: 'image/png', name: 'x' })).toBe(true);
    expect(isImage({ type: '', name: 'shot.PNG' })).toBe(true);
    expect(isImage({ type: '', name: 'notes.txt' })).toBe(false);
  });
});

describe('readAttachment', () => {
  it('extracts UTF-8 text from a text-like file', async () => {
    const a = await readAttachment(file('hello world', 'note.txt', 'text/plain'));
    expect(a.text).toBe('hello world');
    expect(a.truncated).toBe(false);
    expect(a.note).toBeUndefined();
    expect(a.name).toBe('note.txt');
    expect(a.size).toBeGreaterThan(0);
  });

  it('caps very long text at the per-file limit and flags truncation', async () => {
    const big = 'x'.repeat(PER_FILE_CHAR_CAP + 500);
    const a = await readAttachment(file(big, 'big.log', 'text/plain'));
    expect(a.text?.length).toBe(PER_FILE_CHAR_CAP);
    expect(a.truncated).toBe(true);
  });

  it('flags an image as not interpreted, without extracting bytes', async () => {
    const a = await readAttachment(file('PNGDATA', 'capture.png', 'image/png'));
    expect(a.text).toBeUndefined();
    expect(a.note).toMatch(/image/i);
  });

  it('notes a binary file instead of reading garbage', async () => {
    const a = await readAttachment(file('\u0000\u0001bin', 'blob.zip', 'application/zip'));
    expect(a.text).toBeUndefined();
    expect(a.note).toMatch(/non extrait/i);
  });
});

describe('attachmentsToPromptBlock', () => {
  it('returns empty string for no attachments', () => {
    expect(attachmentsToPromptBlock([])).toBe('');
  });

  it('renders a header + body for a text attachment', () => {
    const atts: Attachment[] = [
      { id: '1', name: 'a.log', type: 'text/plain', size: 10, text: 'line one' },
    ];
    const block = attachmentsToPromptBlock(atts);
    expect(block).toContain('--- Pièces jointes ---');
    expect(block).toContain('[Fichier: a.log · text/plain · 10 B]');
    expect(block).toContain('line one');
  });

  it('renders only a header (with the note) for a note-only attachment', () => {
    const atts: Attachment[] = [
      { id: '1', name: 'shot.png', type: 'image/png', size: 2048, note: 'image — non interprétée' },
    ];
    const block = attachmentsToPromptBlock(atts);
    expect(block).toContain('shot.png');
    expect(block).toContain('image — non interprétée');
  });

  it('enforces the total character cap across multiple files', () => {
    const atts: Attachment[] = [
      // First file leaves only 500 chars of budget; the second is capped to that.
      {
        id: '1',
        name: 'a.txt',
        type: 'text/plain',
        size: 1,
        text: 'a'.repeat(TOTAL_CHAR_CAP - 500),
      },
      { id: '2', name: 'b.txt', type: 'text/plain', size: 1, text: 'b'.repeat(1000) },
    ];
    const block = attachmentsToPromptBlock(atts);
    expect(block).toContain('[Fichier: b.txt · text/plain · 1 B]');
    // Exactly 500 of the second file's chars fit, then it is marked truncated.
    expect(block.includes('b'.repeat(500))).toBe(true);
    expect(block.includes('b'.repeat(600))).toBe(false);
    expect(block).toContain('[…tronqué]');
  });

  it('gives each file only its header once the total budget is spent', () => {
    const atts: Attachment[] = [
      { id: '1', name: 'a.txt', type: 'text/plain', size: 1, text: 'a'.repeat(TOTAL_CHAR_CAP) },
      { id: '2', name: 'b.txt', type: 'text/plain', size: 1, text: 'b'.repeat(1000) },
    ];
    const block = attachmentsToPromptBlock(atts);
    // Budget fully consumed by file 1 → file 2 is header-only, no body chars.
    expect(block).toContain('[Fichier: b.txt · text/plain · 1 B]');
    expect(block.includes('b'.repeat(10))).toBe(false);
  });
});

describe('formatSize', () => {
  it('formats bytes, KB and MB', () => {
    expect(formatSize(512)).toBe('512 B');
    expect(formatSize(2048)).toBe('2.0 KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
