import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PluginManager, type PluginManagerProps, type PluginRow } from './plugin-manager';

/**
 * Plugin マネージャの「拡張点」表示（035-social-publishing 設計 §7.9、
 * 受け入れ条件 #103。検証レポート §6 の「判断が分かれる」1 と 3、裁定 #11）。
 *
 * `docs/Plugin開発ガイド.md` と設計 §9.2 は、**資格情報を Plugin へ渡すことの正当化**として
 * 「入れる側が『どの Plugin が資格情報を受け取るか』を導入時に見られるようにしてある」
 * （＝ Manifest の `extensions` 宣言）を挙げている。ところが画面が導入前に見せていたのは
 * **要求 Permission だけ**で、`extensions` はどこにも出ていなかった。
 *
 * **宣言を根拠に設計を通したのだから、宣言が見えるところまでが責任である。**
 *
 * 足す props（`listPlugins` の `PluginSummary` から Server Component が渡す）：
 *
 * ```ts
 * PluginRow = {
 *   …既存,
 *   extensions: readonly string[];   // Manifest の extensions。導入前の行にも出る
 *   publishers: readonly string[];   // Registrations.publishers（有効化した後だけ）
 * }
 * ```
 *
 * * `social` だけでなく `database` / `authentication` / `data` / `events` / `ui` も
 *   同じ場所に出す（`social` だけ特別扱いすると、既にある高権限の拡張点が見えないままになる）
 * * 空なら「—」。**未知の `kind` は生の値をそのまま出す**
 *   （表示側が黙って落とすと「宣言が見える」が成り立たなくなる）
 */

const EXTENSION_LABELS: readonly (readonly [string, string])[] = [
  ['social', 'SNS配信（SNSアカウントの資格情報を受け取ります）'],
  ['database', 'データベース接続（接続情報を受け取ります）'],
  ['authentication', '認証（利用者の認証を担います）'],
  ['data', 'データ参照（本体のデータを読み書きします）'],
  ['events', 'イベント購読'],
  ['ui', '画面の拡張'],
];

const BASE_ROW: PluginRow = {
  id: 'sample-plugin',
  name: 'サンプルPlugin',
  version: '1.0.0',
  status: 'enabled',
  loaded: true,
  permissions: ['site.read'],
  dependencies: {},
  description: null,
  author: null,
  extensions: ['social'],
  publishers: [],
};

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return { ...BASE_ROW, ...overrides };
}

const BASE: PluginManagerProps = {
  installed: [],
  detected: [],
  problems: [],
  operations: [],
  canSelfRestart: true,
  tab: 'installed',
};

function render(overrides: Partial<PluginManagerProps> = {}): string {
  return renderToStaticMarkup(createElement(PluginManager, { ...BASE, ...overrides }));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 導入済みの 1 件だけを描く。 */
function installedText(overrides: Partial<PluginRow> = {}): string {
  return textOf(render({ installed: [row(overrides)] }));
}

/** **導入前**（`plugins/` にあるが未導入）の 1 件だけを描く。 */
function detectedText(overrides: Partial<PluginRow> = {}): string {
  return textOf(render({ detected: [row({ status: null, loaded: false, ...overrides })] }));
}

describe('#103 Plugin マネージャの拡張点表示', () => {
  it('#103 導入済みの行に「拡張点」の見出しが出る', () => {
    expect(installedText()).toContain('拡張点');
  });

  it('#103 導入前の行にも「拡張点」が出る（入れてしまう前に分かる）', () => {
    // **入れてしまった後に分かるのでは、宣言の意味が無い**（設計 §7.9）。
    expect(detectedText()).toContain('拡張点');
  });

  it.each(EXTENSION_LABELS)('#103 %s の表示名が出る', (kind, label) => {
    expect(installedText({ extensions: [kind] })).toContain(label);
  });

  it.each(EXTENSION_LABELS)('#103 導入前の行でも %s の表示名が出る', (kind, label) => {
    expect(detectedText({ extensions: [kind] })).toContain(label);
  });

  it('#103 social の表示は資格情報を受け取ることが読める文言', () => {
    // **何を握るかが読める文言にする**（設計 §7.9）。種類の名前だけでは伝わらない。
    expect(installedText({ extensions: ['social'] })).toContain('資格情報を受け取ります');
  });

  it('#103 複数の宣言はすべて出る', () => {
    const text = installedText({ extensions: ['social', 'data'] });

    expect(text).toContain('SNS配信（SNSアカウントの資格情報を受け取ります）');
    expect(text).toContain('データ参照（本体のデータを読み書きします）');
  });

  it('#103 extensions が空なら「—」', () => {
    const text = installedText({ extensions: [] });

    expect(text).toMatch(/拡張点[\s\S]{0,80}?—/);
  });

  it('#103 空の宣言でどの拡張点の表示名も出さない', () => {
    const text = installedText({ extensions: [] });

    for (const [, label] of EXTENSION_LABELS) {
      expect(text, label).not.toContain(label);
    }
  });

  it('#103 未知の kind は生の値をそのまま出す', () => {
    // 表示側が黙って落とすと「宣言が見える」が成り立たなくなる（設計 §7.9）。
    expect(installedText({ extensions: ['mystery'] })).toContain('mystery');
  });

  it('#103 未知の kind があっても既知の宣言は表示名で出る', () => {
    const text = installedText({ extensions: ['mystery', 'social'] });

    expect(text).toContain('mystery');
    expect(text).toContain('SNS配信（SNSアカウントの資格情報を受け取ります）');
  });

  it('#103 要求 Permission の表示は残る（隣に並べるのであって置き換えない）', () => {
    expect(installedText()).toContain('site.read');
  });
});

/**
 * #103 の後半。**どちらの Plugin が provider を握ったかを確認できる場所**
 * （設計 §7.9、検証レポート §6 の 3）。
 *
 * 「同じ provider は先に有効化したほうが勝つ」は 1 行の規則で保証されているが、
 * 結果を運用者が確かめる場所が無かった。
 */
describe('#103 登録済みの provider', () => {
  it('#103 有効な Plugin の行に登録済みの provider が並ぶ', () => {
    expect(installedText({ publishers: ['example'] })).toContain('example');
  });

  it('#103 登録済みの provider であることが分かる見出しを添える', () => {
    // 値だけ並べても、それが何の一覧なのか読めない（設計 §7.9）。
    expect(installedText({ publishers: ['example'] })).toContain('登録済み');
  });

  it('#103 複数の provider を登録していれば全部並ぶ', () => {
    const text = installedText({ publishers: ['bluesky', 'mastodon'] });

    expect(text).toContain('bluesky');
    expect(text).toContain('mastodon');
  });

  it('#103 登録が無ければ provider の欄を出さない', () => {
    // 負けた側・無効な Plugin は `disabled` と `reason` で説明される（設計 §7.9）。
    expect(installedText({ publishers: [] })).not.toContain('登録済み');
  });

  it('#103 導入前の行には登録済みの provider を出さない（まだ登録していない）', () => {
    expect(detectedText({ publishers: [] })).not.toContain('登録済み');
  });
});
