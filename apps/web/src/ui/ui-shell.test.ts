import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CORE_EXTENSION_POINTS } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES, messageFor } from './client/error-message';
import { CORE_NAVIGATION, visibleNavigation } from './layout/navigation';

const UI_DIR = import.meta.dirname;

async function componentFiles(): Promise<string[]> {
  const dir = join(UI_DIR, 'components');
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith('.tsx')).map((name) => join(dir, name));
}

describe('デザイントークン', () => {
  it('コンポーネントに生の hex 値が書かれていない', async () => {
    // 生の値を書くと、デザインを詰めるときにここを全部触ることになる。
    for (const file of await componentFiles()) {
      const source = readFileSync(file, 'utf8');
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(withoutComments, `${file} に生の hex 値がある`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('コンポーネントに px の直書きが（境界線を除いて）無い', async () => {
    for (const file of await componentFiles()) {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      // 1px の境界線だけは、トークン化しても意味が薄いので許す。
      const offending = [...source.matchAll(/(\d+)px/g)]
        .map((match) => match[1])
        .filter((value) => value !== '1');
      expect(offending, `${file} に px 直書きがある: ${offending.join(', ')}`).toEqual([]);
    }
  });

  it('トークンが CSS 変数として定義されている', () => {
    const css = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');
    for (const token of [
      '--tf-color-bg',
      '--tf-color-text',
      '--tf-color-primary',
      '--tf-color-danger',
      '--tf-space-4',
      '--tf-radius-md',
      '--tf-shadow-1',
      '--tf-font-sans',
      // 028-analytics-dashboard-redesign §7.4.4 で足したトークン（受け入れ条件 #91）。
      '--tf-color-border-weak',
      '--tf-color-chart-1',
      '--tf-color-chart-2',
      '--tf-color-primary-hover',
      '--tf-color-primary-disabled',
      '--tf-color-primary-soft',
      '--tf-color-surface-strong',
      '--tf-color-text-subtle',
      '--tf-radius-pill',
      '--tf-radius-2xl',
      '--tf-size-control',
      '--tf-size-input',
      '--tf-size-header',
      '--tf-size-content',
      '--tf-size-chart-md',
      '--tf-font-mono',
      '--tf-text-kpi',
      '--tf-text-label',
    ]) {
      // `--tf-size-control` が `--tf-size-control-x` の部分一致で通らないよう、定義行（`名前:`）で見る。
      expect(css, `${token} が定義されていない`).toMatch(new RegExp(`${token}\\s*:`));
    }
  });

  it('コンポーネントが参照するトークンがすべて定義されている', async () => {
    const css = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8');
    const defined = new Set([...css.matchAll(/(--tf-[a-z0-9-]+):/g)].map((m) => m[1]));

    for (const file of await componentFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/var\((--tf-[a-z0-9-]+)\)/g)) {
        expect(defined, `${file} が未定義のトークン ${match[1]} を参照している`).toContain(
          match[1],
        );
      }
    }
  });
});

describe('フォント', () => {
  /**
   * フォントのセルフホスト（028-analytics-dashboard-redesign 設計 §7.4.5、受け入れ条件 #92）。
   *
   * **ビルド時にも実行時にも外部（Google Fonts）へ接続しない。**
   * `next/font/google` はビルド時に取りに行くため採らず、`next/font/local` で
   * フォントファイルを OFL の LICENSE とともに同梱する。
   */
  const APP_DIR = join(UI_DIR, '..', 'app');
  const FONTS_DIR = join(APP_DIR, 'fonts');
  const layoutSource = (): string => readFileSync(join(APP_DIR, 'layout.tsx'), 'utf8');

  it('layout.tsx が next/font/local でフォントを読む', () => {
    expect(layoutSource()).toContain('next/font/local');
  });

  it.each(['--font-inter', '--font-jetbrains-mono', '--font-noto-sans-jp'])(
    'layout.tsx が CSS 変数 %s を定義する',
    (variable) => {
      // tokens.css の `--tf-font-sans` / `--tf-font-mono` がこの名前を参照する（§7.4.4）。
      expect(layoutSource()).toContain(variable);
    },
  );

  it('Noto Sans JP は preload しない（ファイルが大きく、初回描画を待たせない）', () => {
    expect(layoutSource()).toMatch(/preload:\s*false/);
  });

  it.each(['Inter[wght].woff2', 'JetBrainsMono[wght].woff2'])(
    'フォントファイル %s が同梱されている',
    (file) => {
      expect(existsSync(join(FONTS_DIR, file)), `${file} が無い`).toBe(true);
    },
  );

  it('Noto Sans JP の woff2 が同梱されている', async () => {
    // Noto は配布元が可変 woff2 を出しておらず変換して置く（実装プラン T14）。
    // ファイル名の細部（`[wght]` の有無）に依存しないよう、接頭辞と拡張子で見る。
    const entries = existsSync(FONTS_DIR) ? await readdir(FONTS_DIR) : [];
    const noto = entries.filter((name) => name.startsWith('NotoSansJP') && name.endsWith('.woff2'));
    expect(noto.length, 'NotoSansJP*.woff2 が無い').toBeGreaterThanOrEqual(1);
  });

  it.each(['LICENSE-Inter.txt', 'LICENSE-JetBrainsMono.txt', 'LICENSE-NotoSansJP.txt'])(
    '%s が OFL の本文である',
    (file) => {
      const path = join(FONTS_DIR, file);
      expect(existsSync(path), `${file} が無い`).toBe(true);
      expect(readFileSync(path, 'utf8')).toMatch(/SIL Open Font License/i);
    },
  );

  it('fonts/README.md に出所とライセンスが書かれている', () => {
    const path = join(FONTS_DIR, 'README.md');
    expect(existsSync(path), 'README.md が無い').toBe(true);
    const readme = readFileSync(path, 'utf8');
    for (const name of ['Inter', 'JetBrains Mono', 'Noto Sans JP']) {
      expect(readme, `${name} の記載が無い`).toContain(name);
    }
    expect(readme).toMatch(/OFL|Open Font License/);
    expect(readme).toMatch(/https?:\/\//);
  });

  it.each([
    ['app/layout.tsx', join(APP_DIR, 'layout.tsx')],
    ['app/globals.css', join(APP_DIR, 'globals.css')],
    ['ui/tokens.css', join(UI_DIR, 'tokens.css')],
  ])('%s が外部のフォント配信を参照していない', (_name, path) => {
    const source = readFileSync(path, 'utf8');
    for (const forbidden of ['fonts.googleapis.com', 'fonts.gstatic.com', 'next/font/google']) {
      expect(source, `${forbidden} への参照がある`).not.toContain(forbidden);
    }
  });
});

describe('ナビゲーション', () => {
  it('主要項目が並ぶ', () => {
    expect(CORE_NAVIGATION.map((item) => item.label)).toEqual([
      'ダッシュボード',
      'Webサイト',
      'キャンペーン',
      'SNS',
      'アナリティクス',
      '設定',
      'プラグイン',
    ]);
  });

  it('行き先の画面が存在する項目だけを載せる', () => {
    // 画面の無い項目を置くと、権限を持つ利用者がクリックしたときに 404 になる。
    const appDir = join(UI_DIR, '..', 'app');

    for (const item of CORE_NAVIGATION) {
      const segment = item.href.replace(/^\//, '');
      expect(existsSync(join(appDir, segment, 'page.tsx')), `${item.href} の画面が無い`).toBe(true);
    }
  });

  it('Permission を持つ項目だけを返す', () => {
    const visible = visibleNavigation(CORE_NAVIGATION, new Set(['site.read']));
    // 設定は誰でも開ける（タブごとの権限は画面側で判定する）。
    expect(visible.map((item) => item.label)).toEqual(['ダッシュボード', 'Webサイト', '設定']);
  });

  it('Permission を1つも持たなくても、誰でも見える項目は残る', () => {
    const visible = visibleNavigation(CORE_NAVIGATION, new Set());
    expect(visible.map((item) => item.label)).toEqual(['ダッシュボード', '設定']);
  });

  it('すべての Permission を持てば全項目が見える', () => {
    const all = new Set(
      CORE_NAVIGATION.map((item) => item.permission).filter((p): p is string => p !== null),
    );
    expect(visibleNavigation(CORE_NAVIGATION, all)).toHaveLength(CORE_NAVIGATION.length);
  });

  it('リンク先が重複していない', () => {
    const hrefs = CORE_NAVIGATION.map((item) => item.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('エラー文言', () => {
  it('既知のコードに日本語文言がある', () => {
    for (const code of ERROR_CODES) {
      const message = messageFor(code);
      expect(message.length, `${code} の文言が空`).toBeGreaterThan(0);
      // 内部の識別子がそのまま出ていないこと。
      expect(message, `${code} の文言がコードそのもの`).not.toBe(code);
    }
  });

  it('未知のコードでも内部の値を出さない', () => {
    expect(messageFor('SOME_INTERNAL_DETAIL')).not.toContain('SOME_INTERNAL_DETAIL');
  });

  it('undefined でも文言を返す', () => {
    expect(messageFor(undefined).length).toBeGreaterThan(0);
  });

  it('サーバーのエラーコードをすべて網羅している', () => {
    const source = readFileSync(join(UI_DIR, '..', 'api', 'errors.ts'), 'utf8');
    const serverCodes = [...source.matchAll(/^\s*\|?\s*'([A-Z_]+)'$/gm)].map((m) => m[1] as string);

    expect(serverCodes.length).toBeGreaterThan(0);
    for (const code of serverCodes) {
      expect(ERROR_CODES, `${code} の表示文言が定義されていない`).toContain(code);
    }
  });
});

describe('表示制御の位置づけ', () => {
  it('PermissionGate に「認可ではない」と明記されている', () => {
    // 表示制御を認可の代わりに使わせないための、コード上の歯止め。
    const source = readFileSync(join(UI_DIR, 'permission-gate.tsx'), 'utf8');
    expect(source).toContain('これは認可ではない');
  });

  it('ナビゲーション定義にも同じ注意がある', () => {
    const source = readFileSync(join(UI_DIR, 'layout', 'navigation.ts'), 'utf8');
    expect(source).toContain('認可ではない');
  });
});

describe('Core の Extension Point', () => {
  /**
   * **描画先がまだ無い拡張点。**
   *
   * 一度公開した名前は消さない（削除は破壊的変更。`07_開発者向けガイド.md` §47）。
   * その代わり、どれが「宣言だけ」なのかをここで固定する。
   * 画面を作ったらこの一覧から外す。外し忘れれば下のテストが落ちる。
   *
   * **いまは空。** Core が公開している拡張点はすべて描画先を持つ。
   */
  const PENDING: Record<string, string> = {};

  async function sourceFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'));
  }

  it('宣言した拡張点は、描画されているか PENDING に理由つきで載っている', async () => {
    // 描画先の無い拡張点は、Plugin 作者から見ると「登録しても何も起きない」だけで、
    // 理由が分からない。宣言と描画の食い違いをここで検出する。
    const files = [
      ...(await sourceFiles(join(UI_DIR, '..', 'app'))),
      ...(await sourceFiles(UI_DIR)),
    ];
    const sources = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    for (const point of CORE_EXTENSION_POINTS) {
      const rendered =
        sources.includes(`point="${point}"`) || sources.includes(`point={'${point}'}`);
      if (PENDING[point] !== undefined) {
        expect(rendered, `${point} は PENDING なのに描画されている。PENDING から外すこと`).toBe(
          false,
        );
      } else {
        expect(rendered, `${point} を描画している画面が無い`).toBe(true);
      }
    }
  });

  it('描画している拡張点は、すべて公開契約に載っている', async () => {
    // **逆向きの検査。** 宣言→描画だけを見ていたため、
    // `campaign.list.actions` / `campaign.edit.sidebar` が
    // 描画されているのに `CORE_EXTENSION_POINTS` へ載らないまま通っていた。
    // 載っていない拡張点は、Plugin 作者が公開定数から見つけられない。
    const files = [
      ...(await sourceFiles(join(UI_DIR, '..', 'app'))),
      ...(await sourceFiles(UI_DIR)),
    ];
    const sources = files.map((file) => readFileSync(file, 'utf8')).join('\n');

    const declared = new Set<string>(CORE_EXTENSION_POINTS);
    const rendered = [...sources.matchAll(/point="([a-z][a-z0-9.]*)"/g)].map((match) => match[1]);

    for (const point of new Set(rendered)) {
      expect(
        declared.has(point as (typeof CORE_EXTENSION_POINTS)[number]),
        `${point} を描画しているが CORE_EXTENSION_POINTS に無い。Plugin 作者から発見できない`,
      ).toBe(true);
    }
  });

  it('PENDING に、もう存在しない拡張点が残っていない', () => {
    for (const point of Object.keys(PENDING)) {
      expect(CORE_EXTENSION_POINTS as readonly string[]).toContain(point);
    }
  });

  /**
   * ダッシュボードの拡張点の順序（028-analytics-dashboard-redesign 設計 §7.2、受け入れ条件 #74）。
   *
   * 画面を作り直しても `dashboard.before` → Core Widget → `PluginWidgets location="dashboard"`
   * → `dashboard.after` の並びを変えない。Plugin は「上に出る」「下に出る」を前提に
   * 登録しているので、順序が入れ替わると Plugin 側から見て挙動が変わる。
   */
  it('dashboard/page.tsx に dashboard.before → location="dashboard" → dashboard.after がこの順で残っている', () => {
    const source = readFileSync(join(UI_DIR, '..', 'app', 'dashboard', 'page.tsx'), 'utf8');
    const markers = ['point="dashboard.before"', 'location="dashboard"', 'point="dashboard.after"'];
    const positions = markers.map((marker) => source.indexOf(marker));

    for (const [index, marker] of markers.entries()) {
      expect(positions[index], `${marker} が dashboard/page.tsx に無い`).toBeGreaterThanOrEqual(0);
      // 同じ拡張点を 2 回描かない。
      expect(source.lastIndexOf(marker), `${marker} が 2 回以上ある`).toBe(positions[index]);
    }
    expect(positions[0], 'dashboard.before は location="dashboard" より前').toBeLessThan(
      positions[1] as number,
    );
    expect(positions[1], 'location="dashboard" は dashboard.after より前').toBeLessThan(
      positions[2] as number,
    );
  });
});
