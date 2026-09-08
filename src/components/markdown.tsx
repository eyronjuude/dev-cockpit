/**
 * Minimal Markdown renderer for specifications and reports.
 *
 * Deliberately not a Markdown library: the input is either a transformer's
 * specification or a report this app wrote itself, both of which use a handful
 * of constructs. Escaping happens first and no raw HTML is ever emitted, so a
 * model-authored specification cannot inject markup into the page.
 */

interface Block {
  type: 'heading' | 'paragraph' | 'list' | 'code' | 'rule' | 'table';
  level?: number;
  text?: string;
  items?: string[];
  rows?: string[][];
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Inline formatting, applied to already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>');
}

function parse(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];

  let paragraph: string[] = [];
  let list: string[] = [];
  let code: string[] | null = null;
  let table: string[][] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    blocks.push({ type: 'list', items: list });
    list = [];
  };
  const flushTable = () => {
    if (!table || table.length === 0) {
      table = null;
      return;
    }
    blocks.push({ type: 'table', rows: table });
    table = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (code !== null) {
      if (line.trimStart().startsWith('```')) {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }

    if (line.trimStart().startsWith('```')) {
      flushAll();
      code = [];
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushAll();
      blocks.push({ type: 'rule' });
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      blocks.push({
        type: 'heading',
        level: heading[1]!.length,
        text: heading[2]!.trim(),
      });
      continue;
    }

    // Table row. The separator row (|---|---|) is skipped.
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      (table ??= []).push(cells);
      continue;
    }
    if (table) flushTable();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1]!.trim());
      continue;
    }

    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      list.push(numbered[1]!.trim());
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (code !== null) blocks.push({ type: 'code', text: code.join('\n') });
  flushAll();

  return blocks;
}

function toHtml(blocks: Block[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(Math.max(block.level ?? 2, 1), 3);
        parts.push(`<h${level}>${inline(escapeHtml(block.text ?? ''))}</h${level}>`);
        break;
      }
      case 'paragraph':
        parts.push(`<p>${inline(escapeHtml(block.text ?? ''))}</p>`);
        break;
      case 'list':
        parts.push(
          `<ul>${(block.items ?? [])
            .map((item) => `<li>${inline(escapeHtml(item))}</li>`)
            .join('')}</ul>`,
        );
        break;
      case 'code':
        parts.push(
          `<pre class="log" style="margin:0.5rem 0"><code>${escapeHtml(block.text ?? '')}</code></pre>`,
        );
        break;
      case 'rule':
        parts.push('<hr />');
        break;
      case 'table': {
        const rows = block.rows ?? [];
        const [head, ...body] = rows;
        const headHtml = head
          ? `<thead><tr>${head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead>`
          : '';
        const bodyHtml = `<tbody>${body
          .map((row) => `<tr>${row.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
          .join('')}</tbody>`;
        parts.push(`<table>${headHtml}${bodyHtml}</table>`);
        break;
      }
    }
  }

  return parts.join('');
}

export function Markdown({ children, className }: { children: string; className?: string }) {
  const html = toHtml(parse(children));
  return (
    <div
      className={`prose-spec ${className ?? ''}`}
      // Safe: every value passed through escapeHtml before any tag was added,
      // and no branch above emits caller-supplied markup.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
