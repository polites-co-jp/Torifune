import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  PluginManager,
  settingsHrefOf,
  type PluginManagerProps,
  type PluginRow,
} from './plugin-manager';

/**
 * `/plugins` の「設定」の行き先（041-plugin-help-docs 設計 §7.6・ユーザー裁定 3、受け入れ条件 #47 / #48）。
 *
 * 041 より前、有効な Plugin の「設定」は `/plugins/<id>`（catch-all。Plugin が `registerPage` していなければ 404）を指していた。
 * 直した後は：
 *
 * | 条件（すべて満たすとき） | 「設定」 |
 * | --- | --- |
 * | `status === 'enabled'` かつ `loaded === true` かつ（`hasSettings` または `help.length > 0`） | 出す。行き先は `/plugins/<id>/settings` |
 * | 上のいずれかを欠く | 出さない |
 *
 * **どの組み合わせでも `/plugins/<id>` を指さない。** 手順書はカードに出さない（ユーザー裁定 2）。
 *
 * `PluginRow` の `hasSettings` / `help` は UI の型では省略できる（実装プラン §8 の 1）。
 * ここでは値を明示して渡す。
 */

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
  extensions: [],
  publishers: [],
  hasSettings: false,
  help: [],
};

const ONE_DOC = [{ id: 'usage', title: '使い方' }] as const;

function row(overrides: Partial<PluginRow> = {}): PluginRow {
  return { ...BASE_ROW, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* #47 settingsHrefOf                                                          */
/* -------------------------------------------------------------------------- */

describe('#47 settingsHrefOf は実在する設定画面だけを返す', () => {
  it('#47 有効・読み込み済み・設定あり・手順書なし → /plugins/<id>/settings', () => {
    expect(settingsHrefOf(row({ hasSettings: true, help: [] }))).toBe(
      '/plugins/sample-plugin/settings',
    );
  });

  it('#47 有効・読み込み済み・設定なし・手順書 1 件 → /plugins/<id>/settings', () => {
    expect(settingsHrefOf(row({ hasSettings: false, help: ONE_DOC }))).toBe(
      '/plugins/sample-plugin/settings',
    );
  });

  it('#47 有効・読み込み済み・設定と手順書の両方あり → /plugins/<id>/settings', () => {
    expect(settingsHrefOf(row({ hasSettings: true, help: ONE_DOC }))).toBe(
      '/plugins/sample-plugin/settings',
    );
  });

  it('#47 設定も手順書も無ければ null', () => {
    expect(settingsHrefOf(row({ hasSettings: false, help: [] }))).toBeNull();
  });

  it("#47 status: 'disabled' なら、設定と手順書があっても null", () => {
    expect(
      settingsHrefOf(row({ status: 'disabled', loaded: false, hasSettings: true, help: ONE_DOC })),
    ).toBeNull();
  });

  it('#47 検出済み（status: null）なら、設定と手順書があっても null', () => {
    expect(
      settingsHrefOf(row({ status: null, loaded: false, hasSettings: true, help: ONE_DOC })),
    ).toBeNull();
  });

  it('#47 有効だが読み込まれていない（再起動待ち）なら、設定と手順書があっても null', () => {
    expect(settingsHrefOf(row({ loaded: false, hasSettings: true, help: ONE_DOC }))).toBeNull();
  });

  it('#47 hasSettings / help を省略した行は、両方無いのと同じく null（既存の props の形）', () => {
    const { hasSettings: _hasSettings, help: _help, ...legacy } = BASE_ROW;

    expect(settingsHrefOf(legacy as PluginRow)).toBeNull();
  });

  it('#47 行き先は行の id から組む', () => {
    expect(settingsHrefOf(row({ id: 'another-plugin', hasSettings: true }))).toBe(
      '/plugins/another-plugin/settings',
    );
  });

  const STATUSES = ['enabled', 'disabled', null] as const;
  const COMBINATIONS = STATUSES.flatMap((status) =>
    [true, false].flatMap((loaded) =>
      [true, false].flatMap((hasSettings) =>
        [[], ONE_DOC].map((help) => ({ status, loaded, hasSettings, help })),
      ),
    ),
  );

  it.each(COMBINATIONS)(
    '#47 どの組み合わせでも /plugins/<id> を返さない（status=$status loaded=$loaded hasSettings=$hasSettings）',
    (combination) => {
      const href = settingsHrefOf(row(combination));

      expect(href).not.toBe('/plugins/sample-plugin');
      if (href !== null) expect(href).toBe('/plugins/sample-plugin/settings');
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #48 PluginManager の描画                                                     */
/* -------------------------------------------------------------------------- */

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
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

interface Anchor {
  readonly href: string | null;
  readonly text: string;
}

function anchors(html: string): Anchor[] {
  return [...html.matchAll(/<a(\s[^>]*)?>([\s\S]*?)<\/a>/g)].map((match) => ({
    href: /\shref="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? null,
    text: textOf(match[2] ?? ''),
  }));
}

/** 文言がちょうど「設定」の要素（リンク・ボタンを問わない）の数。 */
function settingsControls(html: string): number {
  return [...html.matchAll(/>\s*設定\s*</g)].length;
}

/** 行を足していない一覧の「設定」の数（行と関係なく画面にあるもの）。 */
function baselineSettingsControls(): number {
  return settingsControls(render());
}

const QUALIFIED_WITH_SETTINGS = row({ id: 'with-settings', name: '設定あり', hasSettings: true });
const QUALIFIED_WITH_HELP = row({ id: 'with-help', name: '手順書あり', help: ONE_DOC });
const ENABLED_PLAIN = row({ id: 'enabled-plain', name: '何も無い' });
const RESTART_PENDING = row({
  id: 'restart-pending',
  name: '再起動待ち',
  loaded: false,
  hasSettings: true,
  help: ONE_DOC,
});
const DISABLED = row({
  id: 'disabled-one',
  name: '無効',
  status: 'disabled',
  loaded: false,
  hasSettings: true,
  help: ONE_DOC,
});
const DETECTED = row({
  id: 'detected-one',
  name: '検出済み',
  status: null,
  loaded: false,
  hasSettings: true,
  help: ONE_DOC,
});

const ALL_INSTALLED = [
  QUALIFIED_WITH_SETTINGS,
  QUALIFIED_WITH_HELP,
  ENABLED_PLAIN,
  RESTART_PENDING,
  DISABLED,
];

describe('#48 PluginManager の「設定」は /plugins/<id>/settings だけを指す', () => {
  it('#48 どの行についても、末尾が ID で終わる href="/plugins/<id>" のリンクが無い', () => {
    const html = render({ installed: ALL_INSTALLED, detected: [DETECTED] });

    for (const plugin of [...ALL_INSTALLED, DETECTED]) {
      expect(html, plugin.id).not.toContain(`href="/plugins/${plugin.id}"`);
    }
  });

  it('#48 設定を持つ有効な行に、文言「設定」で href="/plugins/<id>/settings" のリンクがある', () => {
    const found = anchors(render({ installed: [QUALIFIED_WITH_SETTINGS] })).filter(
      (anchor) => anchor.href === '/plugins/with-settings/settings',
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('設定');
  });

  it('#48 手順書だけを持つ有効な行にも、文言「設定」で href="/plugins/<id>/settings" のリンクがある', () => {
    const found = anchors(render({ installed: [QUALIFIED_WITH_HELP] })).filter(
      (anchor) => anchor.href === '/plugins/with-help/settings',
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.text).toBe('設定');
  });

  it('#48 条件を満たす行を 1 つ足すと「設定」がちょうど 1 つ増える', () => {
    expect(settingsControls(render({ installed: [QUALIFIED_WITH_HELP] }))).toBe(
      baselineSettingsControls() + 1,
    );
  });

  it.each([
    ['設定も手順書も無い有効な行', ENABLED_PLAIN],
    ['再起動待ちの行', RESTART_PENDING],
    ['無効な行', DISABLED],
  ] as const)('#48 %sには「設定」が無い', (_label, plugin) => {
    const html = render({ installed: [plugin] });

    expect(settingsControls(html)).toBe(baselineSettingsControls());
    expect(html).not.toContain(`href="/plugins/${plugin.id}/settings"`);
  });

  it('#48 検出済みの行には「設定」が無い', () => {
    const html = render({ detected: [DETECTED] });

    expect(settingsControls(html)).toBe(baselineSettingsControls());
    expect(html).not.toContain(`href="/plugins/${DETECTED.id}/settings"`);
  });

  it('#48 まとめて描いても、設定画面へのリンクは条件を満たす 2 行の分だけ', () => {
    const html = render({ installed: ALL_INSTALLED, detected: [DETECTED] });
    const settingsLinks = anchors(html)
      .map((anchor) => anchor.href)
      .filter((href): href is string => href !== null && /^\/plugins\/[^/]+\/settings$/.test(href))
      .sort();

    expect(settingsLinks).toEqual(
      ['/plugins/with-help/settings', '/plugins/with-settings/settings'].sort(),
    );
  });

  it('#48 手順書の題名をカードに出さない（ユーザー裁定 2）', () => {
    const html = render({
      installed: [row({ id: 'titled', help: [{ id: 'a', title: 'カードに出ない題名' }] })],
    });

    expect(textOf(html)).not.toContain('カードに出ない題名');
  });
});
