import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PENDING_KINDS, PENDING_SORTS } from '@/domain/social/pending';
import * as labels from './labels';

/**
 * 送信待ちタブの文言・子ウィンドウの静的検査（055-social-pending-tab 設計 §9.3.4・§9.5.2・§9.8・§9.9、
 * 受け入れ条件 #36・#39・#76 の文言側）。
 *
 * * #36：§9.9 の文言（と §9.3.4 の「今の区画の定数のまま」の行のボタンの名前）が 5 つの部品
 *   （`social-pending.tsx`・`manual-sequence.tsx`・`approval-dialog.tsx`・`bulk-post-actions.tsx`・`post-filter-bar.tsx`）の
 *   **それぞれ**に直書きされず、`labels.ts` にある。`PENDING_KIND_LABEL` のキーが `PENDING_KINDS` とちょうど一致する
 * * #76：`PENDING_SORT_OPTION_LABEL` のキーが `PENDING_SORTS` とちょうど一致する
 * * #39：`ui/` の（テストを除く）ソースで `window.open(` を呼ぶのは `manual-handoff.ts` だけ。`manual-sequence.tsx`・
 *   `social-pending.tsx` は `openManualWindow` を使い、`useEffect` の中で呼ばない（開くのは人のクリックだけ）
 *
 * 述語（`stripComments`・`isHardCoded`・`isHardCodedShort`・`importsFrom`・`calls`）は
 * `bulk-labels-static-checks.test.ts` を**写す**（テストファイルを import しない）。判別力の件も同じ形で置く。
 * `labels.ts` の新しい定数はまだ無いので、名前で引く（`import * as`）。
 *
 * 057-social-bulk-post で追従した（057 設計 §14.1・実装プラン §2）：送信待ちの帯の「選んだ手動投稿を順に投稿」と
 * 順に投稿の終わりの「すべての手動投稿を記録しました」・Toast が無くなるので、その語と `MANUAL_SEQUENCE_LABEL`・
 * `MANUAL_SEQUENCE_DONE`・`MANUAL_SEQUENCE_TOAST`・`MANUAL_SEQUENCE_EXCLUDED_LABEL` の件を外した（消えたことと
 * 057 の新しい語・定数は `bulk-post-static-checks.test.ts` #40 が見る）。#39 の対象に `bulk-post-dialog.tsx` を足した。
 */

const UI_DIR = join(import.meta.dirname, '..');
const SOCIAL_DIR = join(UI_DIR, 'social');

const SOCIAL_LABELS = join(SOCIAL_DIR, 'labels.ts');
const MANUAL_HANDOFF = join(SOCIAL_DIR, 'manual-handoff.ts');
const PENDING_COMPONENT = join(SOCIAL_DIR, 'social-pending.tsx');
const SEQUENCE_COMPONENT = join(SOCIAL_DIR, 'manual-sequence.tsx');
/** 057 の一括投稿のダイアログ（057-social-bulk-post 設計 §7.4。最初の窓を「投稿する」のクリックで開く）。 */
const BULK_POST_DIALOG = join(SOCIAL_DIR, 'bulk-post-dialog.tsx');

/** 文言を直書きしない 5 つの部品（設計 #36）。 */
const COMPONENTS = [
  ['ui/social/social-pending.tsx', PENDING_COMPONENT],
  ['ui/social/manual-sequence.tsx', SEQUENCE_COMPONENT],
  ['ui/social/approval-dialog.tsx', join(SOCIAL_DIR, 'approval-dialog.tsx')],
  ['ui/social/bulk-post-actions.tsx', join(SOCIAL_DIR, 'bulk-post-actions.tsx')],
  ['ui/social/post-filter-bar.tsx', join(SOCIAL_DIR, 'post-filter-bar.tsx')],
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

/** `useEffect` の中で名前の関数を呼んでいるか。 */
function callsInEffect(text: string, name: string): boolean {
  return useEffectBodies(text).some((body) => calls(body, name));
}

function labelValue(name: string): unknown {
  return (labels as unknown as Record<string, unknown>)[name];
}

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];
}

/** `ui/` の（テストを除く）`.ts` / `.tsx`。 */
function uiSources(dir: string = UI_DIR): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return uiSources(path);
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.(ts|tsx)$/.test(name)) return [];
    return [path];
  });
}

function uiPath(path: string): string {
  return `ui/${relative(UI_DIR, path).split(sep).join('/')}`;
}

/* -------------------------------------------------------------------------- */
/* 文言（設計 §9.9・§9.3.4）                                                      */
/* -------------------------------------------------------------------------- */

/** 部品に直書きしない文言のうち、部分文字列で見て誤って当たらない長さのもの（§9.9 の字面）。 */
const PENDING_WORDS = [
  'SNSのタブ',
  '送信待ちの投稿はありません。',
  '投稿の一覧を見る',
  '手が要るもの順',
  '予定の時刻順',
  '承認すると投稿画面を開けます',
  '件目）',
  '経過）',
  '飛ばして次へ',
  '失敗にする',
  '内容が変わっています。読み込み直してから操作してください。',
  '内容が変わっています。この投稿は飛ばして次へ進めます。',
  '投稿画面を開く',
  '別のタブで開く',
  '承認する…',
] as const;

/** 短い語（見出し・選択肢・ボタンの見える文字）。引用符で囲んだ形か JSX のテキストちょうどの形で見る。 */
const PENDING_SHORT_WORDS = [
  '送信待ち',
  '並び順',
  '希望',
  '投稿した',
  '投稿しなかった',
  'やめる',
  '戻る',
  '取りやめ',
  '差し戻す',
] as const;

/** `labels.ts` にあるべき文言（設計 §9.9 が字面を決めているもの）。 */
const LABEL_WORDS = [
  'SNSのタブ',
  '送信待ちの投稿はありません。',
  '投稿の一覧を見る',
  '手が要るもの順',
  '予定の時刻順',
  '承認すると投稿画面を開けます',
  '飛ばして次へ',
  '失敗にする',
  '内容が変わっています。読み込み直してから操作してください。',
  '内容が変わっています。この投稿は飛ばして次へ進めます。',
  '（送信待ちで承認）',
  '/social?pendingStatus=manual_pending',
  '/social?pendingStatus=awaiting_approval',
] as const;

const LABEL_SHORT_WORDS = [
  '送信待ち',
  '並び順',
  '希望',
  '投稿しなかった',
  'やめる',
  '戻る',
] as const;

/** 部品ごとに語を並べた `it.each` の行（`[部品の名前, パス, 語]`）。 */
function perComponent(words: readonly string[]): [string, string, string][] {
  return COMPONENTS.flatMap(([name, path]) =>
    words.map((word): [string, string, string] => [name, path, word]),
  );
}

/* -------------------------------------------------------------------------- */
/* 前提                                                                         */
/* -------------------------------------------------------------------------- */

describe('#36 前提：検査する部品がある（空振りしない）', () => {
  it.each<readonly [string, string]>([
    ...COMPONENTS,
    ['ui/social/manual-handoff.ts', MANUAL_HANDOFF],
    ['ui/social/labels.ts', SOCIAL_LABELS],
  ])('#36 %s がある', (_name, path) => {
    expect(existsSync(path)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* #36 部品に直書きしない                                                         */
/* -------------------------------------------------------------------------- */

describe('#36 5 つの部品のそれぞれに §9.9 の文言を直書きしない', () => {
  it.each(perComponent(PENDING_WORDS))('#36 %s に「%s」を直書きしない', (_name, path, word) => {
    expect(isHardCoded(read(path), word)).toBe(false);
  });

  it.each(perComponent(PENDING_SHORT_WORDS))(
    '#36 %s に「%s」を引用符や JSX のテキストで直書きしない',
    (_name, path, word) => {
      expect(isHardCodedShort(read(path), word)).toBe(false);
    },
  );
});

describe('#36 §9.9 の文言は ui/social/labels.ts にある', () => {
  it.each(LABEL_WORDS)('#36 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it.each(LABEL_SHORT_WORDS)('#36 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(read(SOCIAL_LABELS), word)).toBe(true);
  });

  it('#36 labels.ts の「（送信待ちで承認）」は「（区画で承認）」を置き換える', () => {
    expect(isHardCoded(read(SOCIAL_LABELS), '（区画で承認）')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #36・#76 定数の値とキー                                                        */
/* -------------------------------------------------------------------------- */

describe('#36 #76 labels.ts の定数（設計 §9.9）', () => {
  it('#36 PENDING_KIND_LABEL のキーが PENDING_KINDS とちょうど一致する', () => {
    expect(keysOf(labelValue('PENDING_KIND_LABEL'))).toEqual([...PENDING_KINDS].sort());
  });

  it('#36 PENDING_KIND_LABEL の表示名が手動投稿待ち・承認待ち・予約済み', () => {
    expect(labelValue('PENDING_KIND_LABEL')).toEqual({
      manual_pending: '手動投稿待ち',
      awaiting_approval: '承認待ち',
      scheduled: '予約済み',
    });
  });

  it('#76 PENDING_SORT_OPTION_LABEL のキーが PENDING_SORTS とちょうど一致する', () => {
    expect(keysOf(labelValue('PENDING_SORT_OPTION_LABEL'))).toEqual([...PENDING_SORTS].sort());
  });

  it('#76 PENDING_SORT_OPTION_LABEL の表示名が手が要るもの順・予定の時刻順', () => {
    expect(labelValue('PENDING_SORT_OPTION_LABEL')).toEqual({
      action: '手が要るもの順',
      time: '予定の時刻順',
    });
  });

  it('#36 SOCIAL_TAB_LABEL が 4 つのタブの表示名', () => {
    expect(labelValue('SOCIAL_TAB_LABEL')).toEqual({
      pending: '送信待ち',
      posts: '投稿',
      accounts: 'アカウント',
      history: '配信履歴',
    });
  });

  it.each([
    ['SOCIAL_TABS_LABEL', 'SNSのタブ'],
    ['PENDING_HEADING', '送信待ち'],
    ['PENDING_EMPTY', '送信待ちの投稿はありません。'],
    ['PENDING_EMPTY_POSTS_LINK', '投稿の一覧を見る'],
    ['PENDING_SORT_LABEL', '並び順'],
    ['PENDING_DESIRED_NOTE', '希望'],
    ['PENDING_AWAITING_MANUAL_NOTE', '承認すると投稿画面を開けます'],
    ['MANUAL_SEQUENCE_POSTED', '投稿した'],
    ['MANUAL_SEQUENCE_NOT_POSTED', '投稿しなかった'],
    ['MANUAL_SEQUENCE_QUIT', 'やめる'],
    ['MANUAL_SEQUENCE_SKIP', '飛ばして次へ'],
    ['MANUAL_SEQUENCE_CONFIRM_LABEL', '失敗にする'],
    ['MANUAL_SEQUENCE_BACK', '戻る'],
    ['MANUAL_OUTCOME_STALE_MESSAGE', '内容が変わっています。読み込み直してから操作してください。'],
    ['MANUAL_SEQUENCE_STALE_MESSAGE', '内容が変わっています。この投稿は飛ばして次へ進めます。'],
    ['APPROVAL_PENDING_ROW_NOTE', '（送信待ちで承認）'],
    ['PENDING_MANUAL_HREF', '/social?pendingStatus=manual_pending'],
    ['PENDING_APPROVAL_HREF', '/social?pendingStatus=awaiting_approval'],
  ])('#36 %s が「%s」', (name, value) => {
    expect(labelValue(name)).toBe(value);
  });

  it.each([
    'PENDING_COUNT_OPTION',
    'PENDING_ELAPSED_NOTE',
    'MANUAL_SEQUENCE_TITLE',
    'MANUAL_SEQUENCE_CONFIRM_TITLE',
    'MANUAL_SEQUENCE_CONFIRM_MESSAGE',
    'MANUAL_SEQUENCE_PROGRESS',
  ])('#36 %s がある（字面の組み立ては実装が決める）', (name) => {
    expect(['string', 'function']).toContain(typeof labelValue(name));
  });

  it('#36 MANUAL_HANDOFF_REASON_LABEL.not_scheduled が「承認すると投稿画面を開けます」', () => {
    expect(
      (labelValue('MANUAL_HANDOFF_REASON_LABEL') as Record<string, unknown> | undefined)?.[
        'not_scheduled'
      ],
    ).toBe('承認すると投稿画面を開けます');
  });

  it('#83 MANUAL_HANDOFF_REASON_LABEL.changed が「投稿が変わりました。読み込み直してください」（設計 §8.3。検証 1 回目 S1）', () => {
    expect(
      (labelValue('MANUAL_HANDOFF_REASON_LABEL') as Record<string, unknown> | undefined)?.[
        'changed'
      ],
    ).toBe('投稿が変わりました。読み込み直してください');
  });

  it('#36 判別力：キーが 1 つ欠けた・余る写しは一致しない', () => {
    const missing = Object.fromEntries(PENDING_KINDS.slice(1).map((key) => [key, 'x']));
    const extra = Object.fromEntries([...PENDING_SORTS, 'created'].map((key) => [key, 'x']));

    expect(keysOf(missing)).not.toEqual([...PENDING_KINDS].sort());
    expect(keysOf(extra)).not.toEqual([...PENDING_SORTS].sort());
  });
});

/* -------------------------------------------------------------------------- */
/* #39 子ウィンドウ                                                              */
/* -------------------------------------------------------------------------- */

describe('#39 子ウィンドウを開くのは manual-handoff.ts の openManualWindow だけ', () => {
  it('#39 manual-handoff.ts が window.open を呼ぶ（空振りしない）', () => {
    expect(callsWindowOpen(read(MANUAL_HANDOFF))).toBe(true);
  });

  it('#39 ui/ のほかのソースは window.open を呼ばない', () => {
    const offenders = uiSources()
      .filter((path) => path !== MANUAL_HANDOFF)
      .filter((path) => callsWindowOpen(read(path)))
      .map(uiPath);

    expect(offenders).toEqual([]);
  });

  it.each([
    ['ui/social/social-pending.tsx', PENDING_COMPONENT],
    ['ui/social/manual-sequence.tsx', SEQUENCE_COMPONENT],
    ['ui/social/bulk-post-dialog.tsx', BULK_POST_DIALOG],
  ])('#39 %s は openManualWindow を manual-handoff から import して呼ぶ', (_name, path) => {
    const text = read(path);

    expect(
      importsFrom(text, '@/ui/social/manual-handoff') || importsFrom(text, './manual-handoff'),
    ).toBe(true);
    expect(calls(text, 'openManualWindow')).toBe(true);
  });

  it.each([
    ['ui/social/social-pending.tsx', PENDING_COMPONENT],
    ['ui/social/manual-sequence.tsx', SEQUENCE_COMPONENT],
    ['ui/social/bulk-post-dialog.tsx', BULK_POST_DIALOG],
  ])(
    '#39 %s は useEffect の中で openManualWindow を呼ばない（開くのは人のクリックだけ）',
    (_name, path) => {
      expect(callsInEffect(read(path), 'openManualWindow')).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* 述語の判別力                                                                  */
/* -------------------------------------------------------------------------- */

describe('#36 #39 検査の述語の判別力', () => {
  it('#36 JSX のテキスト・文字列リテラル・属性に直書きした写しを見分ける', () => {
    expect(isHardCoded('<p>送信待ちの投稿はありません。</p>', '送信待ちの投稿はありません。')).toBe(
      true,
    );
    expect(
      isHardCoded(
        "setError('内容が変わっています。この投稿は飛ばして次へ進めます。');",
        '飛ばして次へ',
      ),
    ).toBe(true);
    expect(isHardCoded('<Modal title={`手動投稿（${i} / ${n} 件目）`}>', '件目）')).toBe(true);
  });

  it('#36 コメントの中の文言は数えない', () => {
    const text = [
      '// 「飛ばして次へ」で次の件へ（設計 §9.5.2）',
      '{/* 「並び順」の Select */}',
      '/** 「やめる」はいつでも閉じる */',
      '<Button>{MANUAL_SEQUENCE_QUIT}</Button>',
    ].join('\n');

    expect(isHardCoded(text, '飛ばして次へ')).toBe(false);
    expect(isHardCodedShort(text, '並び順')).toBe(false);
    expect(isHardCodedShort(text, 'やめる')).toBe(false);
  });

  it('#36 短い語は引用符で囲んだ写し・JSX のテキストちょうどの写しを見分け、長い文言の部分に反応しない', () => {
    expect(isHardCodedShort("{ header: '希望' }", '希望')).toBe(true);
    expect(isHardCodedShort('<Button>\n  戻る\n</Button>', '戻る')).toBe(true);
    expect(isHardCodedShort('<p>投稿しなかった件</p>', '投稿しなかった')).toBe(false);
    expect(isHardCodedShort("const t = '希望日時';", '希望')).toBe(false);
  });

  it('#39 window.open の検査はコメントと別の関数を数えない', () => {
    expect(callsWindowOpen('window.open(url, MANUAL_WINDOW_NAME, MANUAL_WINDOW_FEATURES);')).toBe(
      true,
    );
    expect(callsWindowOpen('// window.open(url) はクリックの同期処理の中で')).toBe(false);
    expect(callsWindowOpen('openManualWindow(url, open);')).toBe(false);
  });

  it('#39 useEffect の中の呼び出しを見分ける', () => {
    const inEffect = [
      'useEffect(() => {',
      '  if (current.handoff?.ok) openManualWindow(current.handoff.url, open);',
      '}, [current]);',
    ].join('\n');
    const inClick = [
      'useEffect(() => { router.refresh(); }, [router]);',
      '<Button onClick={() => openManualWindow(url, open)}>{MANUAL_PENDING_OPEN_LABEL}</Button>',
    ].join('\n');

    expect(callsInEffect(inEffect, 'openManualWindow')).toBe(true);
    expect(callsInEffect(inClick, 'openManualWindow')).toBe(false);
    expect(calls(inClick, 'openManualWindow')).toBe(true);
  });
});
