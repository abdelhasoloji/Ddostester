import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown.js';

describe('renderMarkdown — safety', () => {
  it('escapes raw HTML so it cannot inject markup', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('escapes HTML inside inline code', () => {
    const out = renderMarkdown('`a<b & c`');
    expect(out).toContain('<code class="md-code">a&lt;b &amp; c</code>');
  });

  it('escapes HTML inside fenced code', () => {
    const out = renderMarkdown('```\n<b>x</b>\n```');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).not.toContain('<b>x</b>');
  });

  it('only builds https anchors, never javascript: schemes', () => {
    const out = renderMarkdown('[x](javascript:alert(1))');
    expect(out).not.toContain('<a ');
  });
});

describe('renderMarkdown — formatting', () => {
  it('renders bold and italic', () => {
    expect(renderMarkdown('**b**')).toContain('<strong>b</strong>');
    expect(renderMarkdown('a *i* b')).toContain('<em>i</em>');
  });

  it('does not format markdown inside inline code', () => {
    const out = renderMarkdown('`**not bold**`');
    expect(out).toContain('<code class="md-code">**not bold**</code>');
    expect(out).not.toContain('<strong>');
  });

  it('renders a fenced code block with language', () => {
    const out = renderMarkdown('```js\nconst x = 1;\n```');
    expect(out).toContain('<pre class="md-pre" data-lang="js">');
    expect(out).toContain('<code>const x = 1;</code>');
  });

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdown('- a\n- b')).toContain('<ul class="md-ul"><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. a\n2. b')).toContain('<ol class="md-ol"><li>a</li><li>b</li></ol>');
  });

  it('renders headings and blockquotes', () => {
    expect(renderMarkdown('## Titre')).toContain('<h2 class="md-h">Titre</h2>');
    expect(renderMarkdown('> cite')).toContain('<blockquote class="md-quote">cite</blockquote>');
  });

  it('renders an https link with safe rel/target', () => {
    const out = renderMarkdown('[docs](https://ex.io/a)');
    expect(out).toContain('<a href="https://ex.io/a" target="_blank" rel="noopener noreferrer">docs</a>');
  });

  it('wraps plain text in a paragraph and returns empty for empty input', () => {
    expect(renderMarkdown('hello world')).toBe('<p>hello world</p>');
    expect(renderMarkdown('')).toBe('');
  });
});

describe('renderMarkdown — tables & code copy', () => {
  it('renders a GitHub-style table with alignment', () => {
    const out = renderMarkdown('| Metric | Value |\n|:--|--:|\n| RPS | 50 |');
    expect(out).toContain('<table class="md-table">');
    expect(out).toContain('<th style="text-align:left">Metric</th>');
    expect(out).toContain('<th style="text-align:right">Value</th>');
    expect(out).toContain('<td style="text-align:right">50</td>');
  });
  it('escapes cell content in tables', () => {
    const out = renderMarkdown('| a |\n|---|\n| <b> |');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });
  it('adds a copy button to fenced code blocks', () => {
    const out = renderMarkdown('```\nx\n```');
    expect(out).toContain('<button type="button" class="md-copy" aria-label="Copy code">Copy</button>');
  });
});
