import { describe, expect, it } from 'vitest';
import * as publicApi from './index';
import { PLUGIN_HELP_LIMITS, validateManifest, type ManifestValidation } from './manifest';
import { PLUGIN_API_VERSION } from './version';

/**
 * Manifest の `help`（041-plugin-help-docs 設計 §6.1・§9、受け入れ条件 #1〜#6）。
 *
 * `help` は省略できる項目で、**形が誤っていても Manifest を拒否しない。**
 * 041 より前は未知の項目として素通りしていたので、拒否にすると本体の更新だけで
 * 第三者の Plugin が「読み込めなかった Plugin」に落ちる（設計 §9.2）。
 * 誤りは `help` 全体を無いものとして扱い（`manifest` に `help` のキーを持たせない）、
 * `warnings` に `{ field: 'help' }` を 1 件だけ返す。
 *
 * #7（既存の `plugin-api.test.ts` が変更なしで通る）はこのファイルでは持たない。
 */

function baseManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'help-sample',
    name: '手順書のサンプル',
    version: '1.0.0',
    apiVersion: PLUGIN_API_VERSION,
    ...overrides,
  };
}

function doc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'credentials',
    title: '資格情報の用意のしかた',
    path: 'help/credentials.md',
    ...overrides,
  };
}

const VALID_HELP = [
  doc(),
  { id: 'switching', title: '無料版から移るとき', path: 'help/switching.md' },
];

type OkValidation = Extract<ManifestValidation, { ok: true }>;

function expectOk(result: ManifestValidation): OkValidation {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('ok: true を期待した');
  return result;
}

/** `help` が捨てられ、`warnings` がちょうど 1 件（`field: 'help'`）であること。 */
function expectHelpDropped(result: ManifestValidation): void {
  const ok = expectOk(result);
  expect(Object.keys(ok.manifest)).not.toContain('help');
  const warnings = (ok as { readonly warnings?: readonly { field: string; message: string }[] })
    .warnings;
  expect(warnings).toHaveLength(1);
  expect(warnings?.[0]?.field).toBe('help');
  expect(typeof warnings?.[0]?.message).toBe('string');
  expect(warnings?.[0]?.message).not.toBe('');
}

describe('#1 正しい help', () => {
  it('#1 2 件の help を持つ Manifest は ok: true で、help が入力と深く等しい', () => {
    const input = baseManifest({ help: VALID_HELP });

    const ok = expectOk(validateManifest(input));

    expect(ok.manifest.help).toEqual(VALID_HELP);
  });

  it('#1 正しい help のときは warnings のキーそのものが無い', () => {
    const result = validateManifest(baseManifest({ help: VALID_HELP }));

    expect(Object.keys(result)).not.toContain('warnings');
  });

  it('#1 境界値：10 件ちょうど・id 64 文字・title 80 文字（前後の空白を除いて）・path 200 文字は通る', () => {
    const tenDocs = Array.from({ length: 10 }, (_, index) =>
      doc({ id: `doc-${index}`, path: `help/doc-${index}.md` }),
    );
    const boundaries = [
      tenDocs,
      [doc({ id: 'a'.repeat(64) })],
      [doc({ id: '0abc' })],
      [doc({ title: 'あ'.repeat(80) })],
      [doc({ title: `  ${'あ'.repeat(80)}  ` })],
      [doc({ path: `${'a'.repeat(197)}.md` })],
      [doc({ path: 'a.md' })],
      [doc({ path: 'help/sub_dir/a-b.c.md' })],
    ];

    for (const help of boundaries) {
      const result = validateManifest(baseManifest({ help }));
      const ok = expectOk(result);
      expect(ok.manifest.help, JSON.stringify(help).slice(0, 80)).toEqual(help);
      expect(Object.keys(result)).not.toContain('warnings');
    }
  });
});

describe('#2 help を持たない Manifest', () => {
  it('#2 help を持たない Manifest の結果は 041 より前と深く等しい（warnings のキーが無い）', () => {
    const input = baseManifest();

    expect(validateManifest(input)).toStrictEqual({ ok: true, manifest: input });
  });

  it('#2 help: [] は宣言なしと同じで、ok: true・warnings のキーが無い', () => {
    const result = validateManifest(baseManifest({ help: [] }));

    expectOk(result);
    expect(Object.keys(result)).not.toContain('warnings');
  });
});

describe('#3 help の形の誤りは Manifest を拒否せず、help を捨てて警告を 1 件返す', () => {
  const tooManyDocs = Array.from({ length: 11 }, (_, index) =>
    doc({ id: `doc-${index}`, path: `help/doc-${index}.md` }),
  );

  const cases: readonly (readonly [string, unknown])[] = [
    // (a) 文字列（041 より前に独自の意味で使われていたかもしれない形）
    ['(a) help が文字列 "https://example.com"', 'https://example.com'],
    ['(a) help が null', null],
    // (b)
    ['(b) help がオブジェクト', { credentials: 'help/credentials.md' }],
    // (c)
    ['(c) help が 11 件', tooManyDocs],
    // (d)
    ['(d) 要素が文字列', ['help/credentials.md']],
    ['(d) 要素が null', [null]],
    ['(d) 要素が配列', [['credentials', '題名', 'help/credentials.md']]],
    // (e) id
    ["(e) id が ''", [doc({ id: '' })]],
    ["(e) id が 'Token'（大文字）", [doc({ id: 'Token' })]],
    ["(e) id が '-a'（先頭がハイフン）", [doc({ id: '-a' })]],
    ['(e) id が 65 文字', [doc({ id: 'a'.repeat(65) })]],
    ['(e) id が無い', [{ title: '題名', path: 'help/a.md' }]],
    [
      '(e) id が重複',
      [doc({ id: 'same', path: 'help/a.md' }), doc({ id: 'same', path: 'help/b.md' })],
    ],
    // (f) title
    ['(f) title が無い', [{ id: 'credentials', path: 'help/credentials.md' }]],
    ["(f) title が '   '", [doc({ title: '   ' })]],
    ['(f) title が 81 文字', [doc({ title: 'あ'.repeat(81) })]],
    ['(f) title が数値', [doc({ title: 1 })]],
    // (g) path
    ["(g) path が '/help/a.md'（先頭の /）", [doc({ path: '/help/a.md' })]],
    ["(g) path が 'C:/a.md'（ドライブ名）", [doc({ path: 'C:/a.md' })]],
    ["(g) path が 'help\\\\a.md'（バックスラッシュ）", [doc({ path: 'help\\a.md' })]],
    ["(g) path が '../a.md'", [doc({ path: '../a.md' })]],
    ["(g) path が 'help/../a.md'", [doc({ path: 'help/../a.md' })]],
    ["(g) path が './a.md'", [doc({ path: './a.md' })]],
    ["(g) path が '.hidden/a.md'（隠しフォルダ）", [doc({ path: '.hidden/a.md' })]],
    ["(g) path が 'help/.a.md'（隠しファイル）", [doc({ path: 'help/.a.md' })]],
    ["(g) path が 'help//a.md'（空の区切り）", [doc({ path: 'help//a.md' })]],
    ["(g) path が 'a.txt'", [doc({ path: 'a.txt' })]],
    ["(g) path が 'a.MD'（大文字の拡張子）", [doc({ path: 'a.MD' })]],
    ["(g) path が 'a.md.exe'", [doc({ path: 'a.md.exe' })]],
    ["(g) path が 'https://x/a.md'（URL）", [doc({ path: 'https://x/a.md' })]],
    ["(g) path が ''", [doc({ path: '' })]],
    ['(g) path が 201 文字', [doc({ path: `help/${'a'.repeat(193)}.md` })]],
    ['(g) path が無い', [{ id: 'credentials', title: '題名' }]],
    ['(g) path が数値', [doc({ path: 1 })]],
    [
      '(g) path が重複',
      [doc({ id: 'first', path: 'help/a.md' }), doc({ id: 'second', path: 'help/a.md' })],
    ],
  ];

  it('201 文字の path の組み立てが 201 文字ちょうどである（前提の確かめ）', () => {
    expect(`help/${'a'.repeat(193)}.md`).toHaveLength(201);
    expect(`${'a'.repeat(197)}.md`).toHaveLength(200);
  });

  it.each(cases)('#3 %s → ok: true、manifest に help のキーが無い、warnings 1 件', (_, help) => {
    expectHelpDropped(validateManifest(baseManifest({ help })));
  });

  it('#3 1 件だけ誤っていても help 全体を捨てる（全部か無しか）', () => {
    const result = validateManifest(
      baseManifest({ help: [doc(), doc({ id: 'broken', path: '../a.md' })] }),
    );

    expectHelpDropped(result);
  });

  it('#3 help を捨てても他の項目は入力のまま残る', () => {
    const ok = expectOk(
      validateManifest(baseManifest({ description: '説明', help: 'https://example.com' })),
    );

    expect(ok.manifest.id).toBe('help-sample');
    expect(ok.manifest.name).toBe('手順書のサンプル');
    expect(ok.manifest.version).toBe('1.0.0');
    expect(ok.manifest.description).toBe('説明');
  });
});

describe('#4 前方互換', () => {
  it('#4 要素に未知のキー（lang）があっても help が残り、warnings のキーが無い', () => {
    const help = [doc({ lang: 'ja' })];

    const result = validateManifest(baseManifest({ help }));

    const ok = expectOk(result);
    expect(ok.manifest.help).toEqual(help);
    expect(Object.keys(result)).not.toContain('warnings');
  });
});

describe('#5 他の項目の誤り', () => {
  it('#5 help と id の両方が誤り → ok: false で、problems に help が含まれない', () => {
    const result = validateManifest(baseManifest({ id: 'Bad_Id', help: 'https://example.com' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.map((p) => p.field)).not.toContain('help');
  });

  it('#5 その problems は help を持たない同じ Manifest の problems と同じ（従来どおり）', () => {
    const withHelp = validateManifest(baseManifest({ id: 'Bad_Id', help: 'https://example.com' }));
    const withoutHelp = validateManifest(baseManifest({ id: 'Bad_Id' }));

    expect(withHelp).toStrictEqual(withoutHelp);
  });
});

describe('#6 版と上限と公開の出口', () => {
  it('#6 PLUGIN_API_VERSION は 1 のまま', () => {
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it('#6 PLUGIN_HELP_LIMITS が 4 つの値ちょうど', () => {
    expect(PLUGIN_HELP_LIMITS).toEqual({
      maxDocs: 10,
      maxTitleLength: 80,
      maxPathLength: 200,
      maxFileBytes: 262144,
    });
  });

  it('#6 公開の出口（@torifune/plugin-api の index）から PLUGIN_HELP_LIMITS を import できる', () => {
    expect(publicApi.PLUGIN_HELP_LIMITS).toEqual({
      maxDocs: 10,
      maxTitleLength: 80,
      maxPathLength: 200,
      maxFileBytes: 262144,
    });
  });
});
