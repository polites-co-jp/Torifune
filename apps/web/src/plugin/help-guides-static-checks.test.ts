import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateManifest } from '@torifune/plugin-api';
import type { PluginStore, PublisherRegistration } from '@torifune/plugin-api';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHelpLink } from '@/ui/help/help-links';
import type { HelpLinkContext } from '@/ui/help/help-links';
import { MarkdownView } from '@/ui/help/markdown-view';
import { createBlueskyPublisher } from '../../../../plugins/sns-bluesky/social';
import { createInstagramPublisher } from '../../../../plugins/sns-instagram/social';
import { createThreadsPublisher } from '../../../../plugins/sns-threads/social';
import { createXApiPublisher } from '../../../../plugins/sns-x-api/social';

/**
 * 同梱の手順書と README の静的検査（041-plugin-help-docs 設計 §10.9・§12）。
 *
 * 担当する受け入れ条件：#63、#64、#66、#67、#68、#69（実装プラン §2「テスト」の表）。
 * ここで見るのは「配布物のファイルに何が書かれているか」だけで、Plugin を有効化しない。
 *
 * **4 つの SNS Plugin を同じ表で回す。** 手順書を書き終えた Plugin の行だけが緑になり、
 * まだの Plugin の行は「`help` の宣言が無い」「手順書のファイルが無い」で落ちる（G8 の初めの状態）。
 *
 * 注：
 * - ファイル名を `sns-` で始めない（既存の `sns-*-static-checks.test.ts` がテストの本数を
 *   `startsWith('sns-…')` で数えている。実装プラン §1 の確認結果）
 * - #66 (c) は各 Plugin の publisher を**作って** `credentialFields[].label` を読む。
 *   文字列を手で写さない（Plugin の宣言が変われば検査が追従する。実装プラン §2・§8 の 18）
 * - #66 (f) と目次のリンクは、本番と同じ `resolveHelpLink` / `MarkdownView` に通して見る
 *   （見出しの `id` は GitHub と同じ規則に `help-` を前置きする。設計 §7.3.2〜§7.3.4）
 * - 「既存の README の静的検査が変更なしで通る」（#69 の後半）は、既存の
 *   `sns-*-static-checks.test.ts` を**変えずに**走らせることで確かめる（ここには写さない）
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const PLUGINS_DIR = join(REPO_ROOT, 'plugins');

/** 設計 #63 の上限（`PLUGIN_HELP_LIMITS.maxFileBytes`。#6 が同じ値を固定している）。 */
const MAX_FILE_BYTES = 262_144;

/** 設計 §12.4 の表：手順書の `help[0]`。 */
const CREDENTIALS_DOC_ID = 'credentials';
const CREDENTIALS_DOC_PATH = 'help/credentials.md';

/** `store` は `pds-url` を読むためだけに渡す。ここでは publisher を作るだけで、どれも呼ばない。 */
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

interface GuideSpec {
  readonly pluginId: string;
  /** 設計 §12.4 の表：Manifest の `help[0].title`（＝手順書の `#` の題名。§12.3）。 */
  readonly title: string;
  /** 設計 §12.5 の、その SNS の欄の公式文書の URL（#66 (d)。少なくとも 1 つが現れる）。 */
  readonly officialUrls: readonly string[];
  /** 設計 #67 の語（§12.4 の「必ず書くこと」）。 */
  readonly requiredWords: readonly (string | RegExp)[];
  /** 設計 §12.7 の 3：README に残す安全の注意。 */
  readonly readmeSafety: RegExp;
  /** `credentialFields` を読むためだけに作る（`publish()` を呼ばない）。 */
  readonly publisher: () => PublisherRegistration;
}

const GUIDES: readonly GuideSpec[] = [
  {
    pluginId: 'sns-bluesky',
    title: 'App Password（アプリパスワード）の発行手順',
    officialUrls: ['https://bsky.app/settings/app-passwords', 'https://docs.bsky.app/'],
    requiredWords: [
      /ログイン(する|用の)パスワード(ではありません|を(ここへ)?入れないで)/,
      'アプリパスワード',
      '@',
    ],
    readmeSafety: /ログイン(する|用の)パスワード(ではありません|を(ここへ)?入れないで)/,
    publisher: () => createBlueskyPublisher({ store: UNUSED_STORE }),
  },
  {
    pluginId: 'sns-x-api',
    title: 'X API の 4 つの値（OAuth 1.0a）の発行手順',
    officialUrls: [
      'https://docs.x.com/fundamentals/developer-apps',
      'https://docs.x.com/fundamentals/authentication/oauth-1-0a/overview',
      'https://docs.x.com/fundamentals/authentication/oauth-1-0a/api-key-and-secret',
      'https://docs.x.com/x-api/getting-started/getting-access',
      'https://docs.x.com/x-api/getting-started/pricing',
      'https://console.x.com',
    ],
    requiredWords: ['Read and write', 'OAuth 2.0', 'Bearer Token', '4 つとも', '従量課金'],
    readmeSafety: /Authorization/,
    publisher: () => createXApiPublisher(),
  },
  {
    pluginId: 'sns-instagram',
    title: 'Instagram の長期アクセストークンとユーザー ID の用意のしかた',
    officialUrls: [
      'https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login',
      'https://developers.facebook.com/docs/instagram-platform/reference/access_token/',
    ],
    requiredWords: ['プロアカウント', '数字だけ', 'unknown', '60日', 'App Secret'],
    readmeSafety: /App Secret[^。\n]*入れ(ない|ません)/,
    publisher: () => createInstagramPublisher(),
  },
  {
    pluginId: 'sns-threads',
    title: 'Threads の長期アクセストークンとユーザー ID の用意のしかた',
    officialUrls: [
      'https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions/',
      'https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens',
    ],
    requiredWords: [
      'threads_basic',
      'threads_content_publish',
      '数字だけ',
      'unknown',
      '60日',
      'App Secret',
      '24 時間',
    ],
    readmeSafety: /App Secret[^。\n]*入れ(ない|ません)/,
    publisher: () => createThreadsPublisher(),
  },
];

const PLUGIN_IDS = GUIDES.map((guide) => guide.pluginId);

function specOf(pluginId: string): GuideSpec {
  const spec = GUIDES.find((guide) => guide.pluginId === pluginId);
  if (spec === undefined) throw new Error(`表に無い Plugin：${pluginId}`);
  return spec;
}

/* -------------------------------------------------------------------------- */
/* ファイルの読み出し                                                            */
/* -------------------------------------------------------------------------- */

function pluginPath(pluginId: string, ...parts: string[]): string {
  return join(PLUGINS_DIR, pluginId, ...parts);
}

function manifestJson(pluginId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(pluginPath(pluginId, 'plugin.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

interface DeclaredDoc {
  readonly id: string;
  readonly title: string;
  readonly path: string;
}

/** `plugin.json` の `help`。**無ければ落とす**（まだ手順書の無い Plugin の赤の理由）。 */
function declaredHelp(pluginId: string): readonly DeclaredDoc[] {
  const help = manifestJson(pluginId)['help'];
  expect(help, `${pluginId}/plugin.json に help が無い`).toBeDefined();
  expect(Array.isArray(help), `${pluginId}/plugin.json の help が配列でない`).toBe(true);
  return help as readonly DeclaredDoc[];
}

/** 手順書の本文。**ファイルが無ければ落とす**（まだ手順書の無い Plugin の赤の理由）。 */
function guideOf(pluginId: string): string {
  const path = pluginPath(pluginId, CREDENTIALS_DOC_PATH);
  expect(existsSync(path), `${pluginId}/${CREDENTIALS_DOC_PATH} が無い`).toBe(true);
  return readFileSync(path, 'utf8');
}

function readmeOf(pluginId: string): string {
  return readFileSync(pluginPath(pluginId, 'README.md'), 'utf8');
}

/** 手順書の本文の中のリンクを解決する文脈（Manifest の宣言そのもの。設計 §7.3.4）。 */
function linkContextOf(pluginId: string): HelpLinkContext {
  return {
    pluginId,
    currentPath: CREDENTIALS_DOC_PATH,
    docs: declaredHelp(pluginId).map((doc) => ({ id: doc.id, path: doc.path })),
  };
}

/* -------------------------------------------------------------------------- */
/* Markdown の字面の扱い                                                         */
/* -------------------------------------------------------------------------- */

/** コードの囲み（``` / ~~~）の中の行を除く。 */
function withoutFences(markdown: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    if (fence === null) {
      const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (open?.[1] !== undefined) {
        fence = open[1];
        continue;
      }
      kept.push(line);
      continue;
    }
    const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
    if (close?.[1] !== undefined && close[1][0] === fence[0] && close[1].length >= fence.length) {
      fence = null;
    }
  }
  return kept.join('\n');
}

/** インラインのコード（`` `…` ``）を除く。中の `[..](..)` はリンクにならない。 */
function withoutInlineCode(text: string): string {
  return text.replace(/(`+)[\s\S]*?\1/g, '');
}

/** `[文言](href)` の href をすべて拾う（コードの中は除く。画像 `![` は #66 (e) が見る）。 */
function linkHrefsOf(markdown: string): readonly string[] {
  const text = withoutInlineCode(withoutFences(markdown));
  const hrefs: string[] = [];
  for (const match of text.matchAll(
    /(!?)\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:[^\s()]|\([^\s()]*\))*)(?:\s+"[^"\n]*")?\s*\)/g,
  )) {
    if (match[1] === '!') continue;
    const raw = match[2] ?? '';
    hrefs.push(raw.startsWith('<') ? raw.slice(1, -1) : raw);
  }
  return hrefs;
}

/** 見出し（コードの囲みの外の `#` の行）。 */
function headingsOf(
  markdown: string,
): readonly { readonly level: number; readonly text: string }[] {
  const headings: { level: number; text: string }[] = [];
  for (const line of withoutFences(markdown).split('\n')) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      headings.push({ level: match[1].length, text: match[2] });
    }
  }
  return headings;
}

/** `## 目次` から次の `## ` の手前まで（コードの囲みの外）。無ければ `null`。 */
function tocSectionOf(markdown: string): string | null {
  const lines = withoutFences(markdown).split('\n');
  const start = lines.findIndex((line) => /^##\s+目次\s*$/.test(line));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##?\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** 冒頭（最初の見出し 2 より前）。 */
function openingOf(markdown: string): string {
  const lines = markdown.split('\n');
  const end = lines.findIndex((line) => /^##\s/.test(line));
  return (end === -1 ? lines : lines.slice(0, end)).join('\n');
}

/* -------------------------------------------------------------------------- */
/* 描いた HTML の扱い（本番の MarkdownView に通す）                                */
/* -------------------------------------------------------------------------- */

function render(pluginId: string, markdown: string): string {
  return renderToStaticMarkup(
    createElement(MarkdownView, { markdown, linkContext: linkContextOf(pluginId) }),
  );
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 描いた HTML の見出しの `id`（`help-` つき）。 */
function headingIdsOf(html: string, tag = 'h[1-6]'): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const match of html.matchAll(new RegExp(`<(?:${tag})\\b[^>]*\\sid="([^"]*)"`, 'g'))) {
    ids.add(safeDecodeUri(decodeHtmlAttribute(match[1] ?? '')));
  }
  return ids;
}

/** `#断片` を本番と同じ規則で `#help-…` にし、先頭の `#` を除いた `id` を返す。 */
function targetIdOf(pluginId: string, fragmentHref: string): string | null {
  const resolved = resolveHelpLink(fragmentHref, linkContextOf(pluginId));
  if (resolved.kind !== 'internal' || !resolved.href.startsWith('#')) return null;
  return safeDecodeUri(resolved.href.slice(1));
}

/* -------------------------------------------------------------------------- */
/* 本物の fetch を外へ出さない（publisher を作るだけだが念のため。実装プラン §2）         */
/* -------------------------------------------------------------------------- */

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error('help-guides-static-checks は外へ要求を出さない');
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/* -------------------------------------------------------------------------- */
/* #63 SNS の 4 つの Plugin の Manifest の help                                   */
/* -------------------------------------------------------------------------- */

describe('#63 SNS の 4 つの Plugin の plugin.json が手順書を宣言する', () => {
  it.each(PLUGIN_IDS)(
    '#63 %s の help の先頭が { id: credentials, path: help/credentials.md } で題名が §12.4 のとおり',
    (pluginId) => {
      const help = declaredHelp(pluginId);

      expect(help[0]).toMatchObject({
        id: CREDENTIALS_DOC_ID,
        title: specOf(pluginId).title,
        path: CREDENTIALS_DOC_PATH,
      });
    },
  );

  it.each(PLUGIN_IDS)('#63 %s の help は 1 件だけ（設計 §12.4）', (pluginId) => {
    expect(declaredHelp(pluginId)).toHaveLength(1);
  });

  it.each(PLUGIN_IDS)(
    '#63 %s の Manifest に validateManifest が warnings を返さない',
    (pluginId) => {
      const raw = manifestJson(pluginId);
      expect(raw['help'], `${pluginId}/plugin.json に help が無い`).toBeDefined();

      const result = validateManifest(raw);

      expect(result.ok).toBe(true);
      expect(result).not.toHaveProperty('warnings');
      expect(result.ok && result.manifest.help).toEqual(raw['help']);
    },
  );

  it.each(PLUGIN_IDS)('#63 %s が宣言した手順書のファイルが実在し 262144 バイト以下', (pluginId) => {
    const help = declaredHelp(pluginId);
    expect(help.length).toBeGreaterThan(0);

    for (const doc of help) {
      const path = pluginPath(pluginId, doc.path);
      expect(existsSync(path), `${pluginId}/${doc.path} が無い`).toBe(true);
      const stat = statSync(path);
      expect(stat.isFile(), `${pluginId}/${doc.path} が通常のファイルでない`).toBe(true);
      expect(stat.size, `${pluginId}/${doc.path} の大きさ`).toBeLessThanOrEqual(MAX_FILE_BYTES);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #64 sns-x-manual は手順書を持たない、example-plugin は見本 2 本                   */
/* -------------------------------------------------------------------------- */

describe('#64 手順書を持たない Plugin と見本', () => {
  it('#64 sns-x-manual の plugin.json は help を持たない（設計 §11.1 #3）', () => {
    expect(manifestJson('sns-x-manual')).not.toHaveProperty('help');
  });

  it('#64 plugins/sns-x-manual/help/ が無い', () => {
    expect(existsSync(pluginPath('sns-x-manual', 'help'))).toBe(false);
  });

  it('#64 example-plugin の help は usage / markdown の 2 件', () => {
    expect(declaredHelp('example-plugin').map((doc) => doc.id)).toEqual(['usage', 'markdown']);
  });

  it('#64 example-plugin が宣言した手順書のファイルが実在する', () => {
    for (const doc of declaredHelp('example-plugin')) {
      const path = pluginPath('example-plugin', doc.path);
      expect(existsSync(path), `example-plugin/${doc.path} が無い`).toBe(true);
      expect(statSync(path).isFile(), `example-plugin/${doc.path} が通常のファイルでない`).toBe(
        true,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #66 4 つの手順書に共通すること                                                  */
/* -------------------------------------------------------------------------- */

describe('#66 4 つの手順書に共通すること', () => {
  it.each(PLUGIN_IDS)(
    '#66 (a) %s の手順書に「資格情報を設定」と「SNSアカウントを追加」が現れる',
    (pluginId) => {
      const guide = guideOf(pluginId);

      expect(guide).toContain('資格情報を設定');
      expect(guide).toContain('SNSアカウントを追加');
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (b) %s の手順書に「最終確認日：YYYY-MM-DD」の行がちょうど 1 つある',
    (pluginId) => {
      const lines = guideOf(pluginId)
        .split('\n')
        .filter((line) => /最終確認日：\d{4}-\d{2}-\d{2}/.test(line));

      expect(lines).toHaveLength(1);
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (c) %s の手順書に credentialFields の label がすべて宣言のとおりの文字列で現れる',
    (pluginId) => {
      const labels = specOf(pluginId)
        .publisher()
        .credentialFields.map((field) => field.label);
      expect(labels.length, `${pluginId} の credentialFields が空`).toBeGreaterThan(0);

      const guide = guideOf(pluginId);
      for (const label of labels) {
        expect(guide, `欄「${label}」が手順書に無い`).toContain(label);
      }
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (d) %s の手順書に §12.5 の公式文書の URL が少なくとも 1 つ現れる',
    (pluginId) => {
      const guide = guideOf(pluginId);
      const found = specOf(pluginId).officialUrls.filter((url) => guide.includes(url));

      expect(found.length, `§12.5 の ${pluginId} の URL が 1 つも無い`).toBeGreaterThan(0);
    },
  );

  it.each(PLUGIN_IDS)('#66 (e) %s の手順書に画像の記法 ![ が無い', (pluginId) => {
    expect(guideOf(pluginId)).not.toContain('![');
  });

  it.each(PLUGIN_IDS)(
    '#66 (e) %s の手順書のコードの囲みの外に < ＋英字（生の HTML）が無い',
    (pluginId) => {
      const offending = withoutFences(guideOf(pluginId))
        .split('\n')
        .filter((line) => /<[A-Za-z]/.test(line));

      expect(offending).toEqual([]);
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (f) %s の手順書のリンクは https://・宣言した .md への相対パス・# の断片だけ',
    (pluginId) => {
      const guide = guideOf(pluginId);
      const context = linkContextOf(pluginId);
      const hrefs = linkHrefsOf(guide);
      expect(hrefs.length, `${pluginId} の手順書にリンクが 1 つも無い`).toBeGreaterThan(0);

      for (const href of hrefs) {
        const resolved = resolveHelpLink(href, context);
        expect(resolved.kind, `「${href}」がリンクにならない（none）`).not.toBe('none');
        if (resolved.kind === 'external') {
          expect(href, `「${href}」が https:// でない`).toMatch(/^https:\/\//);
        } else {
          // `/social` のような Torifune の中の絶対パスは許さない（実装プラン §8 の 17）。
          expect(href, `「${href}」が Torifune の中の絶対パス`).not.toMatch(/^\//);
        }
      }
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (g) %s の手順書の冒頭に「スクリーンショットは載せていません」の注記がある',
    (pluginId) => {
      expect(openingOf(guideOf(pluginId))).toContain('スクリーンショットは載せていません');
    },
  );

  it.each(PLUGIN_IDS)(
    '#66 (g) %s の手順書の冒頭に「画面の名前」と「変わる」を含む文がある',
    (pluginId) => {
      const sentences = openingOf(guideOf(pluginId)).split(/[。\n]/);

      expect(
        sentences.some(
          (sentence) => sentence.includes('画面の名前') && sentence.includes('変わる'),
        ),
      ).toBe(true);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* §12.3 のひな形（#66 が「ひな形」と呼ぶもの）と目次（§7.3.3）                         */
/* -------------------------------------------------------------------------- */

/** 設計 §12.3 のひな形の見出し 2 の順。間に Plugin ごとの節が入ってよい（§12.4）。 */
const TEMPLATE_H2: readonly (string | RegExp)[] = [
  '目次',
  'この手順書でそろうもの',
  '始める前に用意するもの',
  '全体の流れ',
  /^手順 1(?!\d)/,
  /^手順 \d+：Torifune に入れる$/,
  'うまく入ったか確かめる',
  'よくある間違い',
  '期限と更新',
  '安全のために',
  '画面が違うとき',
  '公式の説明',
];

function matchesHeading(expected: string | RegExp, text: string): boolean {
  return typeof expected === 'string' ? text === expected : expected.test(text);
}

describe('#66 §12.3 のひな形と目次', () => {
  it.each(PLUGIN_IDS)(
    '#66 §12.3 %s の手順書は Manifest の title と同じ見出し 1 から始まる',
    (pluginId) => {
      const firstLine = guideOf(pluginId)
        .split('\n')
        .find((line) => line.trim() !== '');

      expect(firstLine).toBe(`# ${declaredHelp(pluginId)[0]?.title ?? ''}`);
    },
  );

  it.each(PLUGIN_IDS)('#66 §12.3 %s の手順書の見出し 2 がひな形の順に並ぶ', (pluginId) => {
    const h2 = headingsOf(guideOf(pluginId))
      .filter((heading) => heading.level === 2)
      .map((heading) => heading.text);

    let cursor = 0;
    for (const expected of TEMPLATE_H2) {
      const index = h2.findIndex((text, i) => i >= cursor && matchesHeading(expected, text));
      expect(
        index,
        `見出し「${String(expected)}」が順どおりに無い（見出し：${h2.join(' / ')}）`,
      ).not.toBe(-1);
      cursor = index + 1;
    }
  });

  it.each(PLUGIN_IDS)('#66 §12.3 %s の手順書の最後の見出し 2 が「公式の説明」', (pluginId) => {
    const h2 = headingsOf(guideOf(pluginId)).filter((heading) => heading.level === 2);

    expect(h2.at(-1)?.text).toBe('公式の説明');
  });

  it.each(PLUGIN_IDS)('#66 §7.3.3 %s の目次のリンクはすべて # の断片', (pluginId) => {
    const toc = tocSectionOf(guideOf(pluginId));
    expect(toc, `${pluginId} の手順書に「## 目次」が無い`).not.toBeNull();

    const hrefs = linkHrefsOf(toc ?? '');
    expect(hrefs.length, '目次にリンクが無い').toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, `目次の「${href}」が # の断片でない`).toMatch(/^#./);
    }
  });

  it.each(PLUGIN_IDS)(
    '#66 §7.3.3 %s の本文の # の断片のリンクはすべて見出しに届く（GitHub の規則＋help-）',
    (pluginId) => {
      const guide = guideOf(pluginId);
      const ids = headingIdsOf(render(pluginId, guide));
      const fragments = linkHrefsOf(guide).filter((href) => href.startsWith('#'));
      expect(fragments.length, '# の断片のリンクが無い').toBeGreaterThan(0);

      for (const href of fragments) {
        const target = targetIdOf(pluginId, href);
        expect(target, `「${href}」が Torifune の中の断片にならない`).not.toBeNull();
        expect(ids.has(target ?? ''), `「${href}」（→ ${String(target)}）の見出しが無い`).toBe(
          true,
        );
      }
    },
  );

  it.each(PLUGIN_IDS)('#66 §7.3.3 %s の目次が「目次」以外のすべての見出し 2 を指す', (pluginId) => {
    const guide = guideOf(pluginId);
    const h2Ids = [...headingIdsOf(render(pluginId, guide), 'h2')];
    const tocTargets = new Set(
      linkHrefsOf(tocSectionOf(guide) ?? '')
        .filter((href) => href.startsWith('#'))
        .map((href) => targetIdOf(pluginId, href)),
    );
    const tocOwnId = targetIdOf(pluginId, '#目次');
    expect(h2Ids.length).toBeGreaterThan(1);

    const missing = h2Ids.filter((id) => id !== tocOwnId && !tocTargets.has(id));
    expect(missing, '目次から指されていない見出し 2').toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* #67 手順書ごとの語                                                             */
/* -------------------------------------------------------------------------- */

describe('#67 手順書ごとの語（§12.4 の「必ず書くこと」）', () => {
  const cases = GUIDES.flatMap((guide) =>
    guide.requiredWords.map((word) => ({ pluginId: guide.pluginId, word })),
  );

  it.each(cases)('#67 $pluginId の手順書に $word が現れる', ({ pluginId, word }) => {
    const guide = guideOf(pluginId);

    if (typeof word === 'string') {
      expect(guide).toContain(word);
    } else {
      expect(guide).toMatch(word);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* #68 料金・回数の上限の具体的な数値を書かない                                        */
/* -------------------------------------------------------------------------- */

describe('#68 手順書に料金・回数の上限の具体的な数値を書かない', () => {
  it.each(PLUGIN_IDS)('#68 %s の手順書に $＋数字が無い', (pluginId) => {
    expect(guideOf(pluginId)).not.toMatch(/[$＄]\s*\d/);
  });

  it.each(PLUGIN_IDS)('#68 %s の手順書に「数字＋ドル・円・USD・cents」が無い', (pluginId) => {
    expect(guideOf(pluginId)).not.toMatch(/\d[\d,.]*\s*(ドル|円|USD|cents?)/i);
  });

  it.each(PLUGIN_IDS)('#68 %s の手順書に「N 回／分」のような回数の上限が無い', (pluginId) => {
    expect(guideOf(pluginId)).not.toMatch(
      /\d+\s*(回|件|投稿|requests?|posts?)\s*\/\s*(分|時間|24\s*時間|日|min|hour|day)/i,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* #69 README は要約と手順書へのリンク                                               */
/* -------------------------------------------------------------------------- */

describe('#69 README から手順書へ案内する（設計 §12.7）', () => {
  it.each(PLUGIN_IDS)('#69 %s の README に help/credentials.md へのリンクがある', (pluginId) => {
    expect(readmeOf(pluginId)).toMatch(/\]\((\.\/)?help\/credentials\.md\)/);
  });

  it.each(PLUGIN_IDS)(
    '#69 %s の README に画面で読む URL /plugins/<id>/help/credentials が現れる',
    (pluginId) => {
      expect(readmeOf(pluginId)).toContain(`/plugins/${pluginId}/help/credentials`);
    },
  );

  it.each(PLUGIN_IDS)('#69 §12.7 の 3 %s の README に安全に関わる注意が残る', (pluginId) => {
    expect(readmeOf(pluginId)).toMatch(specOf(pluginId).readmeSafety);
  });
});
