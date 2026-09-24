import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { PluginStore, PublisherRegistration } from '@torifune/plugin-api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';

/**
 * 041 の検証の後の改訂（U1・U2・D1〜D11）の静的検査
 * （041-plugin-help-docs 設計 §10.11〜§10.13、受け入れ条件 #87・#92・#93・#98・#99・#101〜#105）。
 *
 * ここで見るのは「配布物・ソース・文書に何が書かれているか」だけで、Plugin を有効化しない。
 *
 * 注：
 * - ファイル名を `sns-` で始めない（既存の `sns-*-static-checks.test.ts` がテストの本数を
 *   名前の一覧で固定している。041 実装プラン §8 の 19）
 * - publisher は `credentialFields` を読むためだけに作る（`publish()` を呼ばない）。
 *   念のため `globalThis.fetch` を「呼ばれたら投げる」にしておく
 * - 「段落」「文」は**空行で区切られたかたまり、またはリストの 1 項目**と読む（041 実装プラン §8 の 30）
 * - #92 の正規表現は**ファイルの全文にそのまま当てる**（行ごとに分けない。041 実装プラン §8 の 26）
 */

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  globalThis.fetch = ((): never => {
    throw new Error('本物の fetch が呼ばれた');
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* 読み出しの道具                                                               */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');
const WEB_SRC = join(REPO_ROOT, 'apps', 'web', 'src');
const DEV_GUIDE = join(REPO_ROOT, 'docs', 'Plugin開発ガイド.md');

const SNS_PLUGINS = ['sns-bluesky', 'sns-x-api', 'sns-instagram', 'sns-threads'] as const;

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function guideOf(pluginId: string): string {
  return readText(join(PLUGINS_DIR, pluginId, 'help', 'credentials.md'));
}

function readmeOf(pluginId: string): string {
  return readText(join(PLUGINS_DIR, pluginId, 'README.md'));
}

/** `dir` の下のファイルを再帰で集める。 */
function filesUnder(dir: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules') continue;
      found.push(...filesUnder(path, pattern));
    } else if (pattern.test(name)) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Markdown を「段落またはリストの 1 項目」に分ける（041 実装プラン §8 の 30）。
 *
 * 空行で区切り、さらにリストの記号（`-` `*` `+` `1.`）で始まる行ごとに分ける。
 * 記号の無い続きの行は直前の項目に含める。
 */
function blocksOf(markdown: string): string[] {
  const blocks: string[] = [];
  for (const chunk of markdown.replaceAll('\r\n', '\n').split(/\n[ \t]*\n/)) {
    let current: string[] = [];
    for (const line of chunk.split('\n')) {
      if (/^\s*([-*+]|\d+\.)\s/.test(line) && current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      current.push(line);
    }
    if (current.length > 0) {
      blocks.push(current.join('\n'));
    }
  }
  return blocks.filter((block) => block.trim() !== '');
}

/** `heading` に合う見出しの節（次の同じ段か上の段の見出しの手前まで）。無ければ `undefined`。 */
function sectionOf(markdown: string, heading: RegExp): string | undefined {
  const lines = markdown.replaceAll('\r\n', '\n').split('\n');
  const start = lines.findIndex((line) => /^#{1,6}\s/.test(line) && heading.test(line));
  if (start === -1) return undefined;
  const level = /^(#+)/.exec(lines[start] ?? '')?.[1]?.length ?? 1;
  const body: string[] = [lines[start] ?? ''];
  for (const line of lines.slice(start + 1)) {
    const match = /^(#{1,6})\s/.exec(line);
    if (match !== null && (match[1]?.length ?? 7) <= level) break;
    body.push(line);
  }
  return body.join('\n');
}

/** `store` は使わない（publisher を作るだけ）。 */
const UNUSED_STORE: PluginStore = {
  get: () => {
    throw new Error('使わない');
  },
  set: () => {
    throw new Error('使わない');
  },
  delete: () => {
    throw new Error('使わない');
  },
  keys: () => {
    throw new Error('使わない');
  },
  setSecret: () => {
    throw new Error('使わない');
  },
  getSecret: () => {
    throw new Error('使わない');
  },
  hasSecret: () => {
    throw new Error('使わない');
  },
};

function fieldOf(publisher: PublisherRegistration, key: string) {
  const field = publisher.credentialFields?.find((item) => item.key === key);
  if (field === undefined) throw new Error(`credentialFields に ${key} が無い`);
  return field;
}

/* -------------------------------------------------------------------------- */
/* #87 sns-instagram の auto（U1）                                              */
/* -------------------------------------------------------------------------- */

describe('#87 sns-instagram の igUserId の欄・手順書・README（U1）', () => {
  const field = () => fieldOf(createInstagramPublisher(), 'igUserId');

  it('#87 label は「Instagram ユーザー ID」のまま', () => {
    expect(field().label).toBe('Instagram ユーザー ID');
  });

  it('#87 description に auto がある', () => {
    expect(field().description ?? '').toMatch(/\bauto\b/);
  });

  it("#87 placeholder が 'auto'", () => {
    expect(field().placeholder).toBe('auto');
  });

  it('#87 手順書に auto がある', () => {
    expect(guideOf('sns-instagram')).toMatch(/\bauto\b/);
  });

  it.each(['アドレス欄', 'access_token=', 'graph.instagram.com/v'])(
    '#87 手順書に %j が現れない（確かめ方 B を消した）',
    (word) => {
      expect(guideOf('sns-instagram')).not.toContain(word);
    },
  );

  it('#87 README に auto がある', () => {
    expect(readmeOf('sns-instagram')).toMatch(/\bauto\b/);
  });
});

/* -------------------------------------------------------------------------- */
/* #92 / #93 sns-bluesky の App Password の形（U2）                              */
/* -------------------------------------------------------------------------- */

describe('#92 sns-bluesky の文言（ログイン用のパスワードは「失敗する」のではなく「送らずに止める」）', () => {
  const OLD_WORDING = 'ログイン用のパスワードでは配信できません';
  const FAILS_WITH_LOGIN_PASSWORD = /ログイン(用|する)の?パスワード[^。]*(失敗|断られ|できません)/;
  const BLUESKY_DIR = join(PLUGINS_DIR, 'sns-bluesky');

  function blueskyFiles(): string[] {
    return [
      ...filesUnder(BLUESKY_DIR, /\.tsx?$/),
      join(BLUESKY_DIR, 'README.md'),
      ...filesUnder(join(BLUESKY_DIR, 'help'), /\.md$/),
    ];
  }

  const description = () =>
    fieldOf(createBlueskyPublisher({ store: UNUSED_STORE }), 'appPassword').description ?? '';

  it('#92 appPassword の description に「xxxx-xxxx-xxxx-xxxx」がある', () => {
    expect(description()).toContain('xxxx-xxxx-xxxx-xxxx');
  });

  it('#92 appPassword の description に「送らずに止め」がある', () => {
    expect(description()).toContain('送らずに止め');
  });

  it(`#92 appPassword の description に「${OLD_WORDING}」が無い`, () => {
    expect(description()).not.toContain(OLD_WORDING);
  });

  it('#92 走査の対象に .ts・README・手順書が含まれる（検査が空振りしない）', () => {
    const names = blueskyFiles().map((path) => relative(BLUESKY_DIR, path).replaceAll('\\', '/'));

    expect(names).toContain('social.ts');
    expect(names).toContain('README.md');
    expect(names).toContain('help/credentials.md');
  });

  it(`#92 sns-bluesky の .ts・README・手順書のどこにも「${OLD_WORDING}」が無い`, () => {
    for (const path of blueskyFiles()) {
      expect(readText(path), relative(REPO_ROOT, path)).not.toContain(OLD_WORDING);
    }
  });

  it('#92 ログイン用のパスワードを入れると失敗すると読める記述が無い（ファイルの全文に当てる）', () => {
    for (const path of blueskyFiles()) {
      const matched = FAILS_WITH_LOGIN_PASSWORD.exec(readText(path));

      expect(matched?.[0] ?? null, relative(REPO_ROOT, path)).toBeNull();
    }
  });

  it('#92 手順書の「よくある間違い」に「App Password（アプリパスワード）の形ではありません」がある', () => {
    const section = sectionOf(guideOf('sns-bluesky'), /よくある間違い/);

    expect(section, '「よくある間違い」の節が無い').toBeDefined();
    expect(section).toContain('App Password（アプリパスワード）の形ではありません');
  });
});

describe('#93 sns-bluesky の App Password の形の正規表現', () => {
  const SHAPE_SOURCE = '/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/';

  /** コメントの行を除いた、`plugins/sns-bluesky/**\/*.ts` の行。 */
  function codeLines(): { readonly path: string; readonly line: string }[] {
    return filesUnder(join(PLUGINS_DIR, 'sns-bluesky'), /\.tsx?$/).flatMap((path) =>
      readText(path)
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .map((line) => ({ path, line })),
    );
  }

  it('#93 §6.5.2 の形ちょうど（フラグなし）の正規表現の定義が 1 か所', () => {
    const found = codeLines().filter(({ line }) => {
      const index = line.indexOf(SHAPE_SOURCE);
      return index !== -1 && !/^[a-z]/.test(line.slice(index + SHAPE_SOURCE.length));
    });

    expect(
      found.map(({ path, line }) => `${relative(REPO_ROOT, path)}: ${line.trim()}`),
    ).toHaveLength(1);
  });

  it('#93 App Password の形を表す別の正規表現（{4} を使うもの）が他に無い', () => {
    const found = codeLines().filter(({ line }) => line.includes('{4}'));

    expect(
      found.map(({ path, line }) => `${relative(REPO_ROOT, path)}: ${line.trim()}`),
    ).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* #98 D9：helpDocPathsOf を消す                                                */
/* -------------------------------------------------------------------------- */

describe('#98 D9：宣言の path を画面へ渡す口は getPluginHelpDoc の結果だけ', () => {
  /** この名前をこのファイルに直書きしない（自分自身に当たらないように）。 */
  const REMOVED_NAME = ['helpDoc', 'PathsOf'].join('');
  const PAGE = join(WEB_SRC, 'app', 'plugins', '[pluginId]', 'help', '[docId]', 'page.tsx');

  it(`#98 apps/web/src のどのファイルにも ${REMOVED_NAME} が現れない`, () => {
    const found = filesUnder(WEB_SRC, /\.(tsx?|mts|cts)$/).filter((path) =>
      readText(path).includes(REMOVED_NAME),
    );

    expect(found.map((path) => relative(REPO_ROOT, path))).toEqual([]);
  });

  it('#98 本文の画面は getPluginHelpDoc を使う', () => {
    expect(readText(PAGE)).toContain('getPluginHelpDoc');
  });

  it.each(['discoverPlugins', 'loadedPlugin', '@/plugin/loader', '@/plugin/registry'])(
    '#98 本文の画面は %s を使わない',
    (name) => {
      expect(readText(PAGE)).not.toContain(name);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* #99 D11：「再ビルドの後から」と予約パス                                        */
/* -------------------------------------------------------------------------- */

describe('#99 D11：README と開発ガイドの URL の案内に「再ビルド」、ガイドに予約パスの実際の挙動', () => {
  it.each(SNS_PLUGINS)(
    '#99 %s の README の /plugins/<id>/help/credentials を案内する段落に「再ビルド」がある',
    (pluginId) => {
      const url = `/plugins/${pluginId}/help/credentials`;
      const blocks = blocksOf(readmeOf(pluginId)).filter((block) =>
        new RegExp(`${url.replaceAll('/', '\\/')}(?!\\.md)`).test(block),
      );

      expect(blocks.length, `${url} を案内する段落が無い`).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).toContain('再ビルド');
      }
    },
  );

  it('#99 開発ガイドの「有効にする前の手順書は plugin.manage が URL で読める」段落に「再ビルド」がある', () => {
    const blocks = blocksOf(readText(DEV_GUIDE)).filter(
      (block) => block.includes('有効にする前') && block.includes('plugin.manage'),
    );

    expect(blocks.length, '有効にする前の手順書の案内が無い').toBeGreaterThan(0);
    for (const block of blocks) {
      expect(block).toContain('再ビルド');
    }
  });

  it('#99 開発ガイドに「/plugins/<plugin-id>/help とその 1 段下は Core」の記述がある', () => {
    const found = blocksOf(readText(DEV_GUIDE)).some(
      (block) =>
        block.includes('/plugins/<plugin-id>/help') &&
        block.includes('1 段下') &&
        block.includes('Core'),
    );

    expect(found).toBe(true);
  });

  it('#99 開発ガイドに「2 段下」の記述がある', () => {
    expect(readText(DEV_GUIDE)).toContain('2 段下');
  });
});

/* -------------------------------------------------------------------------- */
/* #101〜#105 手順書の直し（D3〜D7）                                             */
/* -------------------------------------------------------------------------- */

describe('#101 D7：4 つの手順書に、画面の写真とクリップボードの注意', () => {
  it.each(SNS_PLUGINS)('#101 %s の手順書に「クリップボード」がある', (pluginId) => {
    expect(guideOf(pluginId)).toContain('クリップボード');
  });

  it.each(SNS_PLUGINS)('#101 %s の手順書に「写っていないか」がある', (pluginId) => {
    expect(guideOf(pluginId)).toContain('写っていないか');
  });
});

describe('#102 D6：Threads の上級者向けの節', () => {
  const advanced = () => sectionOf(guideOf('sns-threads'), /上級者向け/);

  it('#102 上級者向けの節がある', () => {
    expect(advanced()).toBeDefined();
  });

  it('#102 上級者向けの節に「アドレス欄に貼らない」（禁止の形）がある', () => {
    expect(advanced()).toContain('アドレス欄に貼らない');
  });

  it('#102 上級者向けの節に「自分が管理するサーバ」がある', () => {
    expect(advanced()).toContain('自分が管理するサーバ');
  });
});

describe('#103 D3：X の手順書の「よくある間違い」の 402 と 403', () => {
  const lines = () =>
    (sectionOf(guideOf('sns-x-api'), /よくある間違い/) ?? '').split('\n').filter(Boolean);

  it('#103 「よくある間違い」に HTTP 402 を含む行がある', () => {
    expect(lines().some((line) => line.includes('HTTP 402'))).toBe(true);
  });

  it('#103 403 の行のうちクレジットの行に「確かめられませんでした」がある', () => {
    const creditLines = lines().filter(
      (line) => line.includes('403') && line.includes('クレジット'),
    );

    expect(creditLines.length).toBeGreaterThan(0);
    expect(creditLines.some((line) => line.includes('確かめられませんでした'))).toBe(true);
  });
});

describe('#104 D4：Threads の 90 日の記述', () => {
  const OLD_SENTENCE =
    '非公開のアカウントでこの期間が過ぎたときに Torifune の配信がどうなるかは確かめていません';

  it('#104 手順書に「90 日」がある', () => {
    expect(guideOf('sns-threads')).toContain('90 日');
  });

  it('#104 「90 日」の段落に「公開」「非公開」「延長」「許可し直」がある', () => {
    const blocks = blocksOf(guideOf('sns-threads')).filter((block) => block.includes('90 日'));

    expect(blocks.length).toBeGreaterThan(0);
    expect(
      blocks.some(
        (block) =>
          /(?<!非)公開/.test(block) &&
          block.includes('非公開') &&
          block.includes('延長') &&
          block.includes('許可し直'),
      ),
    ).toBe(true);
  });

  it('#104 旧い記述が無い', () => {
    expect(guideOf('sns-threads')).not.toContain(OLD_SENTENCE);
  });
});

describe('#105 D5：Instagram の手順書に Graph API の版の表記が無い', () => {
  it('#105 /v\\d+\\.\\d+/ に合う字面が無い', () => {
    const matched = /v\d+\.\d+/.exec(guideOf('sns-instagram'));

    expect(matched?.[0] ?? null).toBeNull();
  });
});
