import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * アカウントの ID のコピーの静的検査（051-social-account-id-display 設計 §7.3・§7.6・§9、
 * 受け入れ条件 #16〜#19）。
 *
 * * #16 写すのは `copyText` だけ（部品に `execCommand` / `navigator.clipboard` を書かない。
 *   `clipboard.ts` にも `execCommand` の代替を置かない）
 * * #17 部品は `@/ui/client/clipboard` の `copyText` を使う
 * * #18 共通 UI Component の公開入口（`ui/components/index.ts`）にコピーの部品を足さない
 * * #19 §7.6 の文言を `social-accounts.tsx` に直書きせず、`labels.ts` に置く
 *
 * `stripComments`・`isHardCoded`・`isHardCodedShort` は `social-credential-static-checks.test.ts`
 * （039 #46）を写す（テストファイルを import しない）。判別力の件も同じ形で置く。
 */

const DIR = import.meta.dirname;
const COMPONENT_PATH = join(DIR, 'social-accounts.tsx');
const LABELS_PATH = join(DIR, 'labels.ts');
const CLIPBOARD_PATH = join(DIR, '..', 'client', 'clipboard.ts');
const COMPONENTS_INDEX_PATH = join(DIR, '..', 'components', 'index.ts');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/* … *\/`（JSX の `{/* … *\/}` を含む）と `// …` を外す。`https://` のような `:` の後は外さない。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 文言が文字列リテラルか JSX のテキストとして現れるか。 */
function isHardCoded(text: string, word: string): boolean {
  return stripComments(text).includes(word);
}

/** 短い語が、引用符で囲まれた形か JSX のテキストちょうどの形で現れるか。 */
function isHardCodedShort(text: string, word: string): boolean {
  const escaped = escapeRegExp(word);
  const quoted = new RegExp(`(['"\`])${escaped}\\1`);
  const jsxText = new RegExp(`>\\s*${escaped}\\s*<`);
  const code = stripComments(text);
  return quoted.test(code) || jsxText.test(code);
}

/* -------------------------------------------------------------------------- */
/* #16 写すのは copyText だけ                                                   */
/* -------------------------------------------------------------------------- */

describe('#16 写すのは copyText だけ', () => {
  it('#16 social-accounts.tsx に execCommand が現れない', () => {
    expect(stripComments(read(COMPONENT_PATH))).not.toContain('execCommand');
  });

  it('#16 social-accounts.tsx に navigator.clipboard が現れない', () => {
    expect(stripComments(read(COMPONENT_PATH))).not.toMatch(/navigator\s*(\?\.|\.)\s*clipboard/);
  });

  it('#16 ui/client/clipboard.ts がある', () => {
    expect(existsSync(CLIPBOARD_PATH)).toBe(true);
  });

  it('#16 ui/client/clipboard.ts に execCommand が現れない', () => {
    const code = stripComments(read(CLIPBOARD_PATH));

    // 前提：Clipboard API で写している（空振りしない）。
    expect(code).toContain('writeText');
    expect(code).not.toContain('execCommand');
  });
});

/* -------------------------------------------------------------------------- */
/* #17 copyText を使う                                                          */
/* -------------------------------------------------------------------------- */

/** `import { …, copyText, … } from '@/ui/client/clipboard'`（`import type` は数えない）。 */
function importsCopyText(text: string): boolean {
  return /import\s*\{[^}]*(?<![\w$])copyText(?![\w$])[^}]*\}\s*from\s*(['"])@\/ui\/client\/clipboard\1/.test(
    stripComments(text),
  );
}

describe('#17 copyText を使う', () => {
  it('#17 social-accounts.tsx が @/ui/client/clipboard から copyText を import している', () => {
    expect(importsCopyText(read(COMPONENT_PATH))).toBe(true);
  });

  it('#17 判別力：複数行の import の中の copyText を見分ける', () => {
    expect(importsCopyText("import {\n  copyText,\n} from '@/ui/client/clipboard';")).toBe(true);
    expect(
      importsCopyText('import { copyText, type ClipboardWriter } from "@/ui/client/clipboard";'),
    ).toBe(true);
  });

  it('#17 判別力：別のモジュール・型だけの import・コメントの中は数えない', () => {
    expect(importsCopyText("import { copyText } from '@/ui/client/api-client';")).toBe(false);
    expect(importsCopyText("import type { copyText } from '@/ui/client/clipboard';")).toBe(false);
    expect(importsCopyText("// import { copyText } from '@/ui/client/clipboard';")).toBe(false);
    expect(importsCopyText("import { copyTextLater } from '@/ui/client/clipboard';")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #18 公開入口を変えない                                                       */
/* -------------------------------------------------------------------------- */

/** `export { … }` / `export type { … }` が外へ出す名前（`as` の後ろの名前を取る。`type` の印は外す）。 */
function exportedNames(text: string): string[] {
  const names: string[] = [];
  for (const block of stripComments(text).matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const entry of (block[1] as string).split(',')) {
      const parts = entry
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/);
      const name = (parts[parts.length - 1] ?? '').trim();
      if (name !== '') names.push(name);
    }
  }
  for (const declaration of stripComments(text).matchAll(
    /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([\w$]+)/g,
  )) {
    names.push(declaration[1] as string);
  }
  return names;
}

const COPY_NAME = /Copy|Clipboard/i;

describe('#18 公開入口を変えない', () => {
  it('#18 ui/components/index.ts が export する名前に Copy / Clipboard を含むものが無い', () => {
    const names = exportedNames(read(COMPONENTS_INDEX_PATH));

    // 前提：既存の公開名を拾えている（空振りしない）。
    expect(names).toContain('Button');
    expect(names).toContain('Toast');
    expect(names.filter((name) => COPY_NAME.test(name))).toEqual([]);
  });

  it('#18 ui/components/index.ts が export * で中身をまとめて出していない', () => {
    // `export *` だと名前を拾えず、上の検査が素通りする。
    expect(stripComments(read(COMPONENTS_INDEX_PATH))).not.toMatch(/export\s+\*/);
  });

  it('#18 判別力：export の並び・別名・型の export に紛れたコピーの部品を見分ける', () => {
    const text = [
      "export { Button, CopyButton, type ButtonProps } from './primitives';",
      "export { copyText as writeToClipboard } from '../client/clipboard';",
      "export type { ClipboardWriter } from '../client/clipboard';",
    ].join('\n');

    expect(exportedNames(text).filter((name) => COPY_NAME.test(name))).toEqual([
      'CopyButton',
      'writeToClipboard',
      'ClipboardWriter',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* #19 文言は labels.ts                                                         */
/* -------------------------------------------------------------------------- */

/** 設計 §7.6 の文言（`aria-label` は表示名とサービスを受けるので、固定の部分で見る）。 */
const WORDS = [
  'アカウントID',
  'アカウントIDをコピーしました。',
  'コピーできませんでした。アカウントIDを選択して写してください。',
  'のアカウントIDをコピー',
] as const;

/** 部分文字列で見ると誤って当たる短い語（ボタンの見える文字）。 */
const SHORT_WORDS = ['コピー'] as const;

describe('#19 social-accounts.tsx に §7.6 の文言を直書きしない', () => {
  it.each(WORDS)('#19 「%s」を直書きしない', (word) => {
    expect(isHardCoded(read(COMPONENT_PATH), word)).toBe(false);
  });

  it.each(SHORT_WORDS)('#19 「%s」を引用符や JSX のテキストで直書きしない', (word) => {
    expect(isHardCodedShort(read(COMPONENT_PATH), word)).toBe(false);
  });
});

describe('#19 文言は labels.ts にある（検査が空振りしていない）', () => {
  it.each(WORDS)('#19 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(LABELS_PATH), word)).toBe(true);
  });

  it.each(SHORT_WORDS)('#19 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(read(LABELS_PATH), word)).toBe(true);
  });
});

describe('#19 検査の述語の判別力', () => {
  it('#19 JSX のテキストに直書きした写しを見分ける', () => {
    expect(isHardCoded('<span>アカウントID</span>', 'アカウントID')).toBe(true);
  });

  it('#19 文字列リテラルに直書きした写しを見分ける', () => {
    expect(
      isHardCoded(
        "setToast({ text: 'アカウントIDをコピーしました。' });",
        'アカウントIDをコピーしました。',
      ),
    ).toBe(true);
    expect(isHardCoded("{ key: 'accountId', header: 'アカウントID' }", 'アカウントID')).toBe(true);
  });

  it('#19 テンプレートリテラルに埋めた写しを見分ける', () => {
    expect(
      isHardCoded(
        'aria-label={`「${account.displayName}（${label}）」のアカウントIDをコピー`}',
        'のアカウントIDをコピー',
      ),
    ).toBe(true);
  });

  it('#19 コメントの中の文言は数えない', () => {
    const text = [
      '// 「アカウントID」の列（051 設計 §7.1）',
      '{/* 押すと「アカウントIDをコピーしました。」を出す */}',
      '/** コピーできませんでした。アカウントIDを選択して写してください。 */',
      '<Button aria-label={accountIdCopyAriaLabel(name, label)}>{ACCOUNT_ID_COPY_LABEL}</Button>',
    ].join('\n');

    expect(isHardCoded(text, 'アカウントID')).toBe(false);
    expect(isHardCoded(text, 'アカウントIDをコピーしました。')).toBe(false);
    expect(
      isHardCoded(text, 'コピーできませんでした。アカウントIDを選択して写してください。'),
    ).toBe(false);
    expect(isHardCodedShort(text, 'コピー')).toBe(false);
  });

  it('#19 短い語は引用符で囲んだ写しを見分ける', () => {
    expect(isHardCodedShort('<Button aria-label="コピー" />', 'コピー')).toBe(true);
    expect(isHardCodedShort("const label = 'コピー';", 'コピー')).toBe(true);
    expect(isHardCodedShort('const label = `コピー`;', 'コピー')).toBe(true);
  });

  it('#19 短い語は JSX のテキストちょうどの写しを見分ける', () => {
    expect(isHardCodedShort('<Button variant="ghost">\n  コピー\n</Button>', 'コピー')).toBe(true);
  });

  it('#19 短い語は長い文言の部分文字列に反応しない', () => {
    expect(isHardCodedShort("const done = 'アカウントIDをコピーしました。';", 'コピー')).toBe(
      false,
    );
    expect(
      isHardCodedShort(
        "const failed = 'コピーできませんでした。アカウントIDを選択して写してください。';",
        'コピー',
      ),
    ).toBe(false);
    expect(isHardCodedShort('<Button>{ACCOUNT_ID_COPY_LABEL}</Button> // コピー', 'コピー')).toBe(
      false,
    );
  });
});
