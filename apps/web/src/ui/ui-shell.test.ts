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
    ]) {
      expect(css, `${token} が定義されていない`).toContain(token);
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

  it('PENDING に、もう存在しない拡張点が残っていない', () => {
    for (const point of Object.keys(PENDING)) {
      expect(CORE_EXTENSION_POINTS as readonly string[]).toContain(point);
    }
  });
});
