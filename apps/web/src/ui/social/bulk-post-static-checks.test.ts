import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as labels from './labels';
import { MANUAL_WINDOW_FEATURES } from './manual-handoff';

/**
 * 一括投稿の文言・窓の静的検査（057-social-bulk-post 設計 §5.4・§7.6、受け入れ条件 #40〜#42）。
 *
 * * #40：新しい・作り直す部品（`bulk-post-dialog.tsx`・`manual-sequence.tsx`・`social-pending.tsx`）の**それぞれ**に
 *   §7.6 の文言を直書きしない。`labels.ts` に §7.6 の定数があり、`BULK_POST_EXCLUDED_LABEL` のキーが 4 つの理由と
 *   ちょうど一致する。消す定数（`MANUAL_SEQUENCE_LABEL`・`_DONE`・`_TOAST`・`_EXCLUDED_LABEL`）が無い
 * * #41：`window.open` を呼ぶのは `manual-handoff.ts` だけ。`bulk-post-dialog.tsx`・`manual-sequence.tsx` は
 *   `openManualWindow` を `manual-handoff` から import し、`useEffect` の中で呼ばない。`MANUAL_WINDOW_FEATURES` が
 *   `noopener=yes`・`noreferrer=yes` を含む（変えない）
 * * #42：`ui/social/` の（テストを除く）ソースは窓の `.closed` を読まず、`setInterval` を使わない（閉じたことを監視しない）
 *
 * 述語は `pending-labels-static-checks.test.ts` を**写す**（テストファイルを import しない）。判別力の件も同じ形で置く。
 * `labels.ts` の新しい定数はまだ無いので、名前で引く（`import * as`）。
 */

const UI_DIR = join(import.meta.dirname, '..');
const SOCIAL_DIR = join(UI_DIR, 'social');

const SOCIAL_LABELS = join(SOCIAL_DIR, 'labels.ts');
const MANUAL_HANDOFF = join(SOCIAL_DIR, 'manual-handoff.ts');
const DIALOG_COMPONENT = join(SOCIAL_DIR, 'bulk-post-dialog.tsx');
const SEQUENCE_COMPONENT = join(SOCIAL_DIR, 'manual-sequence.tsx');
const PENDING_COMPONENT = join(SOCIAL_DIR, 'social-pending.tsx');

/** 文言を直書きしない 3 つの部品（設計 #40）。 */
const COMPONENTS = [
  ['ui/social/bulk-post-dialog.tsx', DIALOG_COMPONENT],
  ['ui/social/manual-sequence.tsx', SEQUENCE_COMPONENT],
  ['ui/social/social-pending.tsx', PENDING_COMPONENT],
] as const;

/** 窓を開く 2 つの部品（設計 #41）。 */
const OPENERS = [
  ['ui/social/bulk-post-dialog.tsx', DIALOG_COMPONENT],
  ['ui/social/manual-sequence.tsx', SEQUENCE_COMPONENT],
] as const;

/** 無いファイルは空として読む（「ある」の検査が赤になり、「直書きしない」の検査は素通りしない）。 */
function read(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

/** `import … from 'specifier'`（値の import。`import type` は数えない）。 */
function importsFrom(text: string, specifier: string): boolean {
  const pattern = new RegExp(
    `import\\s+(?!type\\s)[^;]*?from\\s*(['"])${escapeRegExp(specifier)}\\1`,
  );
  return pattern.test(stripComments(text));
}

/** 名前の関数を呼んでいるか（コメントの外）。 */
function calls(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`).test(stripComments(text));
}

/** `window.open(` を呼んでいるか（コメントの外）。 */
function callsWindowOpen(text: string): boolean {
  return /\bwindow\s*\.\s*open\s*\(/.test(stripComments(text));
}

/** `.closed` を読んでいるか（コメントの外。`isClosed` のような名前の一部は数えない）。 */
function readsClosed(text: string): boolean {
  return /\.\s*closed\b/.test(stripComments(text));
}

/** `setInterval(` を呼んでいるか（コメントの外）。 */
function usesSetInterval(text: string): boolean {
  return /(?<![\w$])setInterval\s*\(/.test(stripComments(text));
}

/** `useEffect(` の引数の範囲（対応する `)` まで）を、現れる順に切り出す。 */
function useEffectBodies(text: string): string[] {
  const code = stripComments(text);
  const bodies: string[] = [];
  const start = /(?<![\w$.])useEffect\s*\(/g;
  for (let match = start.exec(code); match !== null; match = start.exec(code)) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < code.length; index += 1) {
      const char = code[index];
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(code.slice(match.index, index + 1));
  }
  return bodies;
}

function callsInEffect(text: string, name: string): boolean {
  return useEffectBodies(text).some((body) => calls(body, name));
}

function labelValue(name: string): unknown {
  return (labels as unknown as Record<string, unknown>)[name];
}

function labelFunction(name: string): (...args: number[]) => string {
  const value = labelValue(name);
  if (typeof value !== 'function') throw new Error(`labels.ts に関数 ${name} が無い`);
  return value as (...args: number[]) => string;
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];
}

/** `dir` の下の（テストを除く）`.ts` / `.tsx`。 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [path];
  });
}

function uiPath(path: string): string {
  return `ui/${relative(UI_DIR, path).split(sep).join('/')}`;
}

/* -------------------------------------------------------------------------- */
/* 文言（設計 §7.6・§5.4）                                                        */
/* -------------------------------------------------------------------------- */

/** 部品に直書きしない文言のうち、部分文字列で見て誤って当たらない長さのもの（§7.6・§5.4 の字面）。 */
const WORDS = [
  '件を今すぐ送ります',
  '件を承認して投稿します',
  '件を順に投稿画面で開きます',
  '投稿しています…',
  '1 件目の投稿画面を開きました。',
  '一括投稿の結果',
  'は送信待ちに残ります。',
  '承認しましたが投稿画面を開けませんでした（手動投稿待ちに残ります）',
  'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。',
  '記録へ進む',
  '選ぶと次の投稿画面が開きます。',
  '次の投稿画面は開いています。',
  '承認の権限なし',
  '投稿の権限なし',
  '配信待ち・配信中',
  '投稿画面を開けない',
] as const;

/** 短い語（ボタン・題の見える文字）。引用符で囲んだ形か JSX のテキストちょうどの形で見る。 */
const SHORT_WORDS = ['一括投稿', '投稿する'] as const;

/** `labels.ts` にあるべき文言。 */
const LABEL_WORDS = [
  '件を今すぐ送ります',
  '件を承認して投稿します',
  '件を順に投稿画面で開きます',
  '投稿しています…',
  '1 件目の投稿画面を開きました。',
  '一括投稿の結果',
  'は送信待ちに残ります。',
  '承認しましたが投稿画面を開けませんでした（手動投稿待ちに残ります）',
  'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。',
  '記録へ進む',
  '選ぶと次の投稿画面が開きます。',
  '次の投稿画面は開いています。',
  '承認の権限なし',
  '投稿の権限なし',
  '投稿画面を開けない',
] as const;

function perComponent(words: readonly string[]): [string, string, string][] {
  return COMPONENTS.flatMap(([name, path]) =>
    words.map((word): [string, string, string] => [name, path, word]),
  );
}

/* -------------------------------------------------------------------------- */
/* 前提                                                                         */
/* -------------------------------------------------------------------------- */

describe('#40 前提：検査する部品がある（空振りしない）', () => {
  it.each<readonly [string, string]>([
    ...COMPONENTS,
    ['ui/social/manual-handoff.ts', MANUAL_HANDOFF],
    ['ui/social/labels.ts', SOCIAL_LABELS],
  ])('#40 %s がある', (_name, path) => {
    expect(existsSync(path)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #40 部品に直書きしない                                                         */
/* -------------------------------------------------------------------------- */

describe('#40 3 つの部品のそれぞれに §7.6 の文言を直書きしない', () => {
  it.each(perComponent(WORDS))('#40 %s に「%s」を直書きしない', (_name, path, word) => {
    expect(isHardCoded(read(path), word)).toBe(false);
  });

  it.each(perComponent(SHORT_WORDS))(
    '#40 %s に「%s」を引用符や JSX のテキストで直書きしない',
    (_name, path, word) => {
      expect(isHardCodedShort(read(path), word)).toBe(false);
    },
  );
});

describe('#40 §7.6 の文言は ui/social/labels.ts にある', () => {
  it.each(LABEL_WORDS)('#40 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it.each(SHORT_WORDS)('#40 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(read(SOCIAL_LABELS), word)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #40 定数                                                                     */
/* -------------------------------------------------------------------------- */

describe('#40 labels.ts の §7.6 の定数', () => {
  it.each([
    ['BULK_POST_LABEL', '一括投稿'],
    ['BULK_POST_TITLE', '一括投稿'],
    ['BULK_POST_CONFIRM', '投稿する'],
    ['BULK_POST_RUNNING', '投稿しています…'],
    ['BULK_POST_FIRST_OPENED', '1 件目の投稿画面を開きました。'],
    ['BULK_POST_RESULT_TITLE', '一括投稿の結果'],
    [
      'BULK_POST_HANDOFF_FAILED_LABEL',
      '承認しましたが投稿画面を開けませんでした（手動投稿待ちに残ります）',
    ],
    [
      'MANUAL_SEQUENCE_OPENED_GUIDE',
      'SNS の窓で投稿したら、窓を閉じてこの画面に戻ってください。戻ると記録のボタンが出ます。窓が開かないときは『別のタブで開く』を使ってください。',
    ],
    ['MANUAL_SEQUENCE_RECORD_NOW', '記録へ進む'],
    ['MANUAL_SEQUENCE_NEXT_GUIDE', '選ぶと次の投稿画面が開きます。'],
    ['MANUAL_SEQUENCE_NEXT_OPENED', '次の投稿画面は開いています。'],
  ])('#40 %s が「%s」', (name, value) => {
    expect(labelValue(name)).toBe(value);
  });

  it('#40 BULK_POST_MANUAL_GUIDE が文字列で、空でない', () => {
    const value = labelValue('BULK_POST_MANUAL_GUIDE');

    expect(typeof value).toBe('string');
    expect(String(value).length).toBeGreaterThan(0);
  });

  it.each(['BULK_POST_LEAD', 'BULK_POST_MANUAL_RESULT'])(
    '#40 %s が関数（字面の組み立ては実装が決める）',
    (name) => {
      expect(typeof labelValue(name)).toBe('function');
    },
  );

  it('#40 BULK_POST_LEAD(6, 5) が選んだ件数と対象の件数を含む', () => {
    const text = labelFunction('BULK_POST_LEAD')(6, 5);

    expect(text).toMatch(/6\s*件/);
    expect(text).toMatch(/5\s*件/);
  });

  it('#40 BULK_POST_PUBLISH_NOW_LINE(1) が「自動配信の予約 1 件を今すぐ送ります」', () => {
    expect(labelFunction('BULK_POST_PUBLISH_NOW_LINE')(1)).toBe(
      '自動配信の予約 1 件を今すぐ送ります',
    );
  });

  it('#40 BULK_POST_APPROVE_LINE(2, 1, 1) が「承認待ち 2 件を承認して投稿します（自動 1・手動 1）」', () => {
    expect(labelFunction('BULK_POST_APPROVE_LINE')(2, 1, 1)).toBe(
      '承認待ち 2 件を承認して投稿します（自動 1・手動 1）',
    );
  });

  it('#40 BULK_POST_APPROVE_LINE は 0 件の側を書かない（自動だけ・手動だけ）', () => {
    expect(labelFunction('BULK_POST_APPROVE_LINE')(2, 2, 0)).toBe(
      '承認待ち 2 件を承認して投稿します（自動 2）',
    );
    expect(labelFunction('BULK_POST_APPROVE_LINE')(1, 0, 1)).toBe(
      '承認待ち 1 件を承認して投稿します（手動 1）',
    );
  });

  it('#40 BULK_POST_MANUAL_LINE(3) が「手動投稿 3 件を順に投稿画面で開きます」', () => {
    expect(labelFunction('BULK_POST_MANUAL_LINE')(3)).toBe('手動投稿 3 件を順に投稿画面で開きます');
  });

  it('#40 BULK_POST_UNRECORDED(2) が「記録していない手動投稿 2 件は送信待ちに残ります。」', () => {
    expect(labelFunction('BULK_POST_UNRECORDED')(2)).toBe(
      '記録していない手動投稿 2 件は送信待ちに残ります。',
    );
  });

  it('#40 BULK_POST_MANUAL_RESULT は 0 件の結果を書かない', () => {
    const text = labelFunction('BULK_POST_MANUAL_RESULT')(2, 0, 1);

    expect(text).toMatch(/投稿した\s*2/);
    expect(text).toMatch(/飛ばした\s*1/);
    expect(text).not.toContain('投稿しなかった');
  });

  it('#40 BULK_POST_EXCLUDED_LABEL のキーが 4 つの理由とちょうど一致し、表示名が設計 §5.2 のとおり', () => {
    const value = labelValue('BULK_POST_EXCLUDED_LABEL');

    expect(keysOf(value)).toEqual(
      [
        'no_approve_permission',
        'no_write_permission',
        'due_or_publishing',
        'handoff_unavailable',
      ].sort(),
    );
    expect(value).toEqual({
      no_approve_permission: '承認の権限なし',
      no_write_permission: '投稿の権限なし',
      due_or_publishing: '配信待ち・配信中',
      handoff_unavailable: '投稿画面を開けない',
    });
  });

  it.each([
    'MANUAL_SEQUENCE_LABEL',
    'MANUAL_SEQUENCE_DONE',
    'MANUAL_SEQUENCE_TOAST',
    'MANUAL_SEQUENCE_EXCLUDED_LABEL',
  ])('#40 消す定数 %s が無い', (name) => {
    expect(labelValue(name)).toBeUndefined();
  });

  it.each([
    'MANUAL_SEQUENCE_TITLE',
    'MANUAL_SEQUENCE_POSTED',
    'MANUAL_SEQUENCE_NOT_POSTED',
    'MANUAL_SEQUENCE_QUIT',
    'MANUAL_SEQUENCE_SKIP',
    'MANUAL_SEQUENCE_SKIPPED',
    'MANUAL_SEQUENCE_CONFIRM_TITLE',
    'MANUAL_SEQUENCE_CONFIRM_MESSAGE',
    'MANUAL_SEQUENCE_CONFIRM_LABEL',
    'MANUAL_SEQUENCE_BACK',
    'MANUAL_SEQUENCE_PROGRESS',
    'MANUAL_SEQUENCE_SCHEDULED_LABEL',
    'MANUAL_SEQUENCE_STALE_MESSAGE',
  ])('#40 残す定数 %s がある', (name) => {
    expect(['string', 'function']).toContain(typeof labelValue(name));
  });

  it('#40 labels.ts に「選んだ手動投稿を順に投稿」「すべての手動投稿を記録しました」が無い', () => {
    expect(isHardCoded(read(SOCIAL_LABELS), '選んだ手動投稿を順に投稿')).toBe(false);
    expect(isHardCoded(read(SOCIAL_LABELS), 'すべての手動投稿を記録しました')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #41 窓の開き方                                                                */
/* -------------------------------------------------------------------------- */

describe('#41 窓を開くのは manual-handoff.ts の openManualWindow だけ', () => {
  it('#41 manual-handoff.ts が window.open を呼ぶ（空振りしない）', () => {
    expect(callsWindowOpen(read(MANUAL_HANDOFF))).toBe(true);
  });

  it('#41 ui/ のほかのソースは window.open を呼ばない', () => {
    const offenders = sources(UI_DIR)
      .filter((path) => path !== MANUAL_HANDOFF)
      .filter((path) => callsWindowOpen(read(path)))
      .map(uiPath);

    expect(offenders).toEqual([]);
  });

  it.each(OPENERS)(
    '#41 %s は openManualWindow を manual-handoff から import して呼ぶ',
    (_n, path) => {
      const text = read(path);

      expect(
        importsFrom(text, '@/ui/social/manual-handoff') || importsFrom(text, './manual-handoff'),
      ).toBe(true);
      expect(calls(text, 'openManualWindow')).toBe(true);
    },
  );

  it.each(OPENERS)('#41 %s は useEffect の中で openManualWindow を呼ばない', (_n, path) => {
    expect(read(path)).not.toBe('');
    expect(callsInEffect(read(path), 'openManualWindow')).toBe(false);
  });

  it('#41 MANUAL_WINDOW_FEATURES が noopener=yes・noreferrer=yes を含む（変えない）', () => {
    const parts = MANUAL_WINDOW_FEATURES.split(',').map((part) => part.trim());

    expect(parts).toContain('noopener=yes');
    expect(parts).toContain('noreferrer=yes');
  });
});

/* -------------------------------------------------------------------------- */
/* #42 閉じたことを監視しない                                                       */
/* -------------------------------------------------------------------------- */

describe('#42 ui/social/ は窓を閉じたことを監視しない', () => {
  it('#42 前提：manual-sequence.tsx がある（空振りしない）', () => {
    expect(read(SEQUENCE_COMPONENT)).not.toBe('');
  });

  it('#42 ui/social/ のソースは .closed を読まない', () => {
    expect(
      sources(SOCIAL_DIR)
        .filter((path) => readsClosed(read(path)))
        .map(uiPath),
    ).toEqual([]);
  });

  it('#42 ui/social/ のソースは setInterval を使わない', () => {
    expect(
      sources(SOCIAL_DIR)
        .filter((path) => usesSetInterval(read(path)))
        .map(uiPath),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 述語の判別力                                                                  */
/* -------------------------------------------------------------------------- */

describe('#40 #41 #42 検査の述語の判別力', () => {
  it('#40 直書きの写しを見分け、コメントの中は数えない', () => {
    expect(
      isHardCoded("setText('次の投稿画面は開いています。');", '次の投稿画面は開いています。'),
    ).toBe(true);
    expect(isHardCoded('// 「記録へ進む」で戻らずに記録する', '記録へ進む')).toBe(false);
    expect(isHardCodedShort("<Button>{'一括投稿'}</Button>", '一括投稿')).toBe(true);
    expect(isHardCodedShort('<Button>\n  投稿する\n</Button>', '投稿する')).toBe(true);
    expect(isHardCodedShort('<p>一括投稿の結果</p>', '一括投稿')).toBe(false);
  });

  it('#41 useEffect の中の呼び出しを見分ける', () => {
    const inEffect = 'useEffect(() => { openManualWindow(next.url, open); }, [next]);';
    const inClick = [
      "useEffect(() => { window.addEventListener('focus', onBack); }, []);",
      '<Button onClick={() => openManualWindow(url, open)}>{BULK_POST_CONFIRM}</Button>',
    ].join('\n');

    expect(callsInEffect(inEffect, 'openManualWindow')).toBe(true);
    expect(callsInEffect(inClick, 'openManualWindow')).toBe(false);
  });

  it('#42 .closed と setInterval の写しを見分け、名前の一部・コメントは数えない', () => {
    expect(readsClosed('if (win.closed) next();')).toBe(true);
    expect(readsClosed('if (win?.closed) next();')).toBe(true);
    expect(readsClosed('const isClosed = true;')).toBe(false);
    expect(readsClosed('// win.closed は COOP で開いた直後から true')).toBe(false);
    expect(usesSetInterval('const timer = setInterval(check, 500);')).toBe(true);
    expect(usesSetInterval('window.setInterval(check, 500);')).toBe(true);
    expect(usesSetInterval('// setInterval で監視しない')).toBe(false);
  });
});
