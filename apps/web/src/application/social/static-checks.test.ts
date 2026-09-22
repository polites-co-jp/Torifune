import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { JOB_NAMES } from '@/domain/jobs/job';
import { JOB_LABEL } from '@/ui/analytics/labels';

/**
 * SNS 配信まわりの静的検査（035-social-publishing、受け入れ条件 #18（境界）、#59、
 * #67、#81〜#84、および実装プラン §8「G3 からの申し送り」の `§6.7 の回帰`）。
 *
 * `application/jobs/static-checks.test.ts` と同じ流儀で、ソース・ファイルと
 * 定数の形を固定する。
 */

/** apps/web/src/application/social → apps/web/src */
const SRC_DIR = join(import.meta.dirname, '..', '..');
/** apps/web/src → リポジトリルート */
const REPO_ROOT = join(SRC_DIR, '..', '..', '..');
const DOCS_DIR = join(REPO_ROOT, 'docs');

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
}

/** ディレクトリ直下の `.ts` / `.tsx`（テストを除く）。 */
function sourceFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => join(dir, name));
}

/** ディレクトリ以下のすべての `.ts` / `.tsx`（テストを除く）。 */
function sourceFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFilesUnder(path));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

/** `export const <名前> = defineRoute({ … })` の中身（次の `export const` まで）。 */
function routeBlock(source: string, name: string): string {
  const start = source.indexOf(`export const ${name} = defineRoute(`);
  expect(start, `${name} の定義が無い`).toBeGreaterThanOrEqual(0);
  const rest = source.slice(start + 1);
  const end = rest.search(/^export const /m);
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * #59。ジョブ定義の形（設計 §6.5.1）。
 *
 * `lockName` を書かなければ `job.lockName ?? job.name` が自分の名前に落ち、
 * ロールアップ・Webhook と並行して走れる。書くと他のジョブと直列化される。
 */
describe('#59 ジョブ定義の形', () => {
  it('#59 SOCIAL_PUBLISH_JOB.lockName が未定義（social.publish 自身の鍵を取る）', () => {
    expect((SOCIAL_PUBLISH_JOB as { lockName?: string }).lockName).toBeUndefined();
  });

  it('#59 SOCIAL_PUBLISH_JOB の名前が social.publish', () => {
    expect(SOCIAL_PUBLISH_JOB.name).toBe('social.publish');
  });

  it('#59 JOB_NAMES の最後が social.publish', () => {
    // **末尾に足す。** この順がそのまま設定画面「定期実行」の行順になる。
    expect(JOB_NAMES[JOB_NAMES.length - 1]).toBe('social.publish');
  });

  it('#59 既存のジョブ名の順序が変わっていない', () => {
    expect(JOB_NAMES).toEqual([
      'analytics.rollup',
      'webhook.deliver',
      'analytics.timezoneRebuild',
      'social.publish',
    ]);
  });

  it('#59 JOB_LABEL に social.publish の表示名がある', () => {
    expect(JOB_LABEL['social.publish']).toBe('SNS 投稿の配信');
  });
});

/** #67。環境変数の案内と、起動フックを変えていないこと（設計 §6.5.1）。 */
describe('#67 .env.example と instrumentation.ts', () => {
  const envExample = readFileSync(join(REPO_ROOT, '.env.example'), 'utf8');

  it('#67 TORIFUNE_SOCIAL_PUBLISH_INTERVAL_MINUTES の行があり、既定値が 1', () => {
    expect(envExample).toMatch(/^TORIFUNE_SOCIAL_PUBLISH_INTERVAL_MINUTES=1$/m);
  });

  it('#67 TORIFUNE_SCHEDULER の案内に POST /api/v1/social/publish がある', () => {
    // `off` の運用を SNS でも成り立たせる（設計 §6.5.9）。
    expect(envExample).toContain('/api/v1/social/publish');
  });

  it('#67 instrumentation.ts は prepare の注入のままで、SNS 固有の記述が無い', () => {
    // `prepare` は既存（`ensurePluginsStartedAnonymously`）。ジョブが増えても
    // 起動フックは変わらない（設計 §6.5.1 の `prepare` の行）。
    const source = withoutComments(readFileSync(join(SRC_DIR, 'instrumentation.ts'), 'utf8'));

    expect(source).toMatch(/bootScheduler\s*\(\s*\{\s*prepare:\s*ensurePluginsStartedAnonymously/);
    expect(source).not.toContain('social');
  });
});

/**
 * #18 の境界部分（設計 §9.1）。
 *
 * 公開 Plugin API は本体へ依存しない（一方向）。`packages/plugin-api` 側の
 * 「パッケージの境界」テストが全ファイルを見ているが、**この作業で足した
 * `social.ts` と、その題材である `plugins/example-plugin/social.ts` が
 * 境界を割っていないこと**をここでも固定する。Plugin 作者が写す実物だからである。
 */
describe('#18 SNS 配信の公開契約の境界', () => {
  const pluginApiSocial = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'social.ts');
  const examplePluginSocial = join(REPO_ROOT, 'plugins', 'example-plugin', 'social.ts');

  it('#18 検査対象の 2 ファイルが存在する', () => {
    expect(existsSync(pluginApiSocial), 'packages/plugin-api/src/social.ts が無い').toBe(true);
    expect(existsSync(examplePluginSocial), 'plugins/example-plugin/social.ts が無い').toBe(true);
  });

  it.each(['@torifune/web', 'apps/web', '@/'])(
    '#18 packages/plugin-api/src/social.ts が %s を import しない',
    (forbidden) => {
      const source = withoutComments(readFileSync(pluginApiSocial, 'utf8'));

      expect(source).not.toMatch(
        new RegExp(`from\\s+['"]${forbidden.replaceAll('/', '\\/')}`, 'm'),
      );
    },
  );

  it.each(['pg', 'kysely', 'next', 'react', 'zod'])(
    '#18 packages/plugin-api/src/social.ts が %s を import しない',
    (forbidden) => {
      // 本体が使うライブラリの変更が、Plugin API の破壊的変更にならないように。
      const source = withoutComments(readFileSync(pluginApiSocial, 'utf8'));

      expect(source).not.toMatch(new RegExp(`from\\s+['"]${forbidden}(/|['"])`));
    },
  );

  it('#18 plugins/example-plugin/social.ts の import 元が @torifune/plugin-api だけ', () => {
    // Plugin は公開 API だけを見る（Plugin開発ガイド §11「やってはいけないこと」）。
    const source = withoutComments(readFileSync(examplePluginSocial, 'utf8'));
    const sources = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);

    expect(sources.length).toBeGreaterThanOrEqual(1);
    for (const module of sources) {
      expect(module, `${String(module)} を import している`).toBe('@torifune/plugin-api');
    }
  });
});

/**
 * #81。改訂した文書（設計 §12）。
 *
 * **公開ガイドが実装と食い違ったままにならないこと**を固定する。
 * 文言そのものではなく「矛盾する文が消えたか」「要点が書かれているか」を見る。
 */
describe('#81 ドキュメントの改訂', () => {
  const guide = readFileSync(join(DOCS_DIR, 'Plugin開発ガイド.md'), 'utf8');
  const eventReference = readFileSync(join(DOCS_DIR, 'Eventリファレンス.md'), 'utf8');

  it('#81 Plugin開発ガイドに「Core は Plugin へ資格情報を渡さない」が無い', () => {
    // 035 で方針を改めた（設計 §12）。残っていると公開ガイドが実装と食い違う。
    expect(guide).not.toContain('Core は Plugin へ資格情報を渡さない');
  });

  it('#81 Plugin開発ガイドに「資格情報を自分の名前空間で持つ」という SNS 向けの指示が無い', () => {
    expect(guide).not.toContain('SNS の投稿を行う Plugin は、その資格情報を自分の名前空間で持つ');
  });

  it('#81 Plugin開発ガイドに registerPublisher の節がある', () => {
    expect(guide).toContain('registerPublisher');
    expect(guide).toMatch(/^### SNS 配信（`social`）$/m);
  });

  it('#81 Plugin開発ガイドに extensions: [social] の宣言が書かれている', () => {
    expect(guide).toMatch(/"extensions":\s*\["social"\]/);
  });

  it.each([
    ['credentialFields', 'credentialFields'],
    ['limits', 'limits'],
    ['validate', 'validate'],
    ['publish', 'publish'],
    ['manual', 'manual'],
    ['rotatedCredential', 'rotatedCredential'],
  ])('#81 Plugin開発ガイドの SNS 配信の節に %s が出てくる', (_label, token) => {
    expect(guide).toContain(token);
  });

  it('#81 Plugin開発ガイドに retryable の基準が書かれている', () => {
    // 「送る前に失敗した」なら true、「届いたか分からない」なら false（設計 §9.2）。
    expect(guide).toContain('retryable');
    expect(guide).toContain('送る前に失敗した');
    expect(guide).toContain('届いたか分からない');
  });

  it('#81 Plugin開発ガイドに「例外は結果不明で failed になる」と書かれている', () => {
    expect(guide).toMatch(/例外を投げると[^\n]*failed|例外は「結果不明」になる/);
    expect(guide).toContain('結果不明');
  });

  it('#81 Plugin開発ガイドに「資格情報の値をログに渡さない」と書かれている', () => {
    expect(guide).toContain('資格情報の値をログに渡さない');
  });

  it('#81 Plugin開発ガイドに「同じ provider は 1 Plugin」と書かれている', () => {
    expect(guide).toContain('PluginPublisherConflictError');
    expect(guide).toMatch(/同じ `provider` を登録できるのは 1 つの Plugin だけ/);
  });

  it('#81 Plugin開発ガイドに「手動投稿の画面は Core が持つ」と書かれている', () => {
    expect(guide).toMatch(/手動投稿の待ち行列[^\n]*Torifune の画面/);
  });

  it('#81 Plugin開発ガイドが plugins/example-plugin/social.ts を実物として挙げている', () => {
    expect(guide).toContain('plugins/example-plugin/social.ts');
  });

  /**
   * 裁定 #8（2026-09-23）。**配信 Plugin が無くても予約は断られない。**
   * 「予約が 422 になる」と書くとガイドが実装と食い違う。
   */
  it('#81 Plugin開発ガイドが「publish 未実装でも自動配信の予約は断られない」と書いている', () => {
    expect(guide).toContain('自動配信の予約は断られない');
  });

  it('#81 Eventリファレンスに social.post.failed の行がある', () => {
    expect(eventReference).toMatch(/^\| `social\.post\.failed` \|/m);
  });

  it('#81 Eventリファレンスの social.post.published に定期実行の契機が足されている', () => {
    const line = eventReference
      .split('\n')
      .find((row) => row.startsWith('| `social.post.published` |'));

    expect(line, 'social.post.published の行が無い').toBeDefined();
    expect(line).toContain('定期実行');
  });

  it('#81 Eventリファレンスに status の値の説明がある', () => {
    expect(eventReference).toContain("`social.post.failed` なら `'failed'`");
  });

  it('#81 010-plugin-api 設計 §5 に 035 への追記がある', () => {
    const design = readFileSync(join(DOCS_DIR, '設計', '010-plugin-api', '設計.md'), 'utf8');
    const start = design.search(/^### 資格情報の扱い/m);
    expect(start, '§5「資格情報の扱い」が見つからない').toBeGreaterThanOrEqual(0);
    const rest = design.slice(start);
    const end = rest.search(/^## 6\./m);
    const section = end === -1 ? rest : rest.slice(0, end);

    expect(section).toContain('035-social-publishing');
    // 「既知の重複」は解消した（Core 自身の使い道ができた）。
    expect(section).toContain('解消');
  });

  it('#81 マニュアル「SNS投稿の外部連携」がある', () => {
    const manual = readFileSync(join(DOCS_DIR, 'マニュアル', 'SNS投稿の外部連携.md'), 'utf8');

    for (const token of [
      '/api/v1/social/accounts',
      '/api/v1/social/posts',
      '/api/v1/social/publish',
      'externalRef',
      'failureReason',
      'deliveryMode',
    ]) {
      expect(manual, `${token} の説明が無い`).toContain(token);
    }
  });
});

/**
 * #82。レイヤの境界（設計 §4 / §4.1）。
 *
 * Domain は DB 製品も公開 Plugin API も知らない。Application は SQL を持たず、
 * `plugin/` を import しない（登録簿は Application 側にあり、`plugin/` がそれを呼ぶ）。
 */
describe('#82 レイヤの境界', () => {
  const domainFiles = sourceFilesIn(join(SRC_DIR, 'domain', 'social'));
  const applicationFiles = sourceFilesIn(join(SRC_DIR, 'application', 'social'));

  it('#82 検査対象のファイルがある（検査が空振りしていない）', () => {
    expect(domainFiles.length).toBeGreaterThanOrEqual(3);
    expect(applicationFiles.length).toBeGreaterThanOrEqual(3);
  });

  it.each([
    "from 'pg'",
    "from 'kysely'",
    "'@torifune/plugin-api'",
    "'@/infrastructure",
    "'@/plugin",
  ])('domain/social/*.ts が %s を import しない', (forbidden) => {
    for (const file of domainFiles) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${relative(REPO_ROOT, file)} が ${forbidden} を含む`).not.toContain(
        forbidden,
      );
      expect(source, `${relative(REPO_ROOT, file)} が ${forbidden} を含む`).not.toContain(
        forbidden.replaceAll("'", '"'),
      );
    }
  });

  it('#82 application/social/*.ts に .db の参照が無い（SQL は Repository）', () => {
    for (const file of applicationFiles) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${relative(REPO_ROOT, file)} が .db に触れている`).not.toMatch(/\.db\b/);
    }
  });

  it('#82 application/social/*.ts が @/plugin/ を import しない', () => {
    // 依存の向きは `plugin/` → `application/social/publisher-registry`（設計 §4.1）。
    for (const file of applicationFiles) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      expect(source, `${relative(REPO_ROOT, file)} が @/plugin/ を import している`).not.toMatch(
        /from ['"]@\/plugin\//,
      );
    }
  });

  it('#82 plugin/context.ts が @/application/social/publisher-registry を import する', () => {
    // 向きが逆でないことの裏取り（片方の禁止だけでは、両方が無いのと区別できない）。
    const source = withoutComments(readFileSync(join(SRC_DIR, 'plugin', 'context.ts'), 'utf8'));

    expect(source).toMatch(/from ['"]@\/application\/social\/publisher-registry['"]/);
  });
});

/**
 * #83。`Secret.expose()` の呼び出し箇所（設計 §6.5.5）。
 *
 * 平文を取り出す場所が増えると、その数だけ漏れる経路が増える。
 * **呼び出し箇所を数えて固定する。** 増やすときはここを意識して直すことになる。
 */
describe('#83 Secret.expose() の呼び出し箇所', () => {
  /** 035 の時点で `.expose()` を呼んでよいファイル（リポジトリルートからの相対パス）。 */
  const ALLOWED = [
    'apps/web/src/application/social/publish.ts',
    'apps/web/src/application/webhook/deliver.ts',
    'apps/web/src/plugin/store.ts',
  ];

  it('#83 本体（テストを除く）で .expose() を呼ぶのは 3 ファイルだけ', () => {
    const callers = sourceFilesUnder(SRC_DIR)
      .filter((file) => /\.expose\(\)/.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file).replaceAll('\\', '/'))
      .sort();

    expect(callers).toEqual([...ALLOWED].sort());
  });

  it('#83 publish.ts の .expose() が 1 回だけ', () => {
    const source = withoutComments(
      readFileSync(join(SRC_DIR, 'application', 'social', 'publish.ts'), 'utf8'),
    );

    expect(source.match(/\.expose\(\)/g) ?? []).toHaveLength(1);
  });
});

/**
 * #84。Plugin 由来の自由文をログ・DB に載せる経路の秘匿（設計 §6.5.5）。
 *
 * `reason` も例外のメッセージも Plugin が書いた自由文で、接続文字列や
 * 資格情報を含みうる。`application/jobs/static-checks.test.ts` と同じ形で、
 * **組み立てている場所が `redactSecrets` を通していること**を固定する。
 */
describe('#84 Plugin 由来の自由文の秘匿', () => {
  /** 生のメッセージをそのまま `reason` にしている書き方。 */
  const RAW_REASON = /reason:\s*\w+\s+instanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(/;
  /** 例外オブジェクトの `message` を素通しで `reason` にしている書き方。 */
  const RAW_MESSAGE = /reason:\s*\w+\.message\b/;

  it.each([
    ['api/route.ts', join(SRC_DIR, 'api', 'route.ts')],
    ['application/social/publish.ts', join(SRC_DIR, 'application', 'social', 'publish.ts')],
    ['application/jobs/scheduler.ts', join(SRC_DIR, 'application', 'jobs', 'scheduler.ts')],
  ])('#84 %s が redactSecrets を通し、生の message を reason にしていない', (_label, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source, 'redactSecrets を使っていない').toContain('redactSecrets');
    expect(source, '生の message をそのまま reason にしている').not.toMatch(RAW_REASON);
    expect(source, '生の message をそのまま reason にしている').not.toMatch(RAW_MESSAGE);
  });

  it('#84 publish.ts が資格情報の値も伏せる（redactCredentialValues）', () => {
    // `redactSecrets` は接続文字列しか見ない。Plugin が reason へ混ぜた
    // 資格情報の値は `redactCredentialValues` でしか落ちない（設計 §5.6.2）。
    const source = withoutComments(
      readFileSync(join(SRC_DIR, 'application', 'social', 'publish.ts'), 'utf8'),
    );

    expect(source).toContain('redactCredentialValues');
  });

  it('#84 publish.ts が reason を出している（検査が空振りしていない）', () => {
    const source = withoutComments(
      readFileSync(join(SRC_DIR, 'application', 'social', 'publish.ts'), 'utf8'),
    );

    expect(source).toMatch(/reason:/);
  });
});

/**
 * §6.7 の回帰（実装プラン §8「G3 からの申し送り」）。
 *
 * **publisher の登録簿は `activate()` で埋まるが、Bearer 認証の API 経路は
 * `ensurePluginsStarted*` を通らない。** 呼ばないと、登録簿が空のまま
 * `deliveryMode: 'manual'` が 422 になり、`limits` / `validate()` も掛からずに通る。
 *
 * **同一プロセスの結合テストでは、この呼び出しを消しても落とせない。**
 * テスト自身が先に `ensurePluginsStartedAnonymously()` を呼んでおり、
 * `bootState.promise` を使い回すのでルート側の呼び出しは 2 回目以降ただの no-op になる
 * （実装プラン §8「リスク4 の宿題の結果」）。**ここが唯一の回帰になる。**
 */
describe('§6.7 登録簿を引くルートが Plugin を起こす', () => {
  const API_DIR = join(SRC_DIR, 'app', 'api', 'v1', 'social');

  const ROUTES: readonly (readonly [string, string, string])[] = [
    ['POST /social/posts', join(API_DIR, 'posts', 'route.ts'), 'POST'],
    ['PATCH /social/posts/{id}', join(API_DIR, 'posts', '[id]', 'route.ts'), 'PATCH'],
    ['POST /social/accounts', join(API_DIR, 'accounts', 'route.ts'), 'POST'],
    ['PATCH /social/accounts/{id}', join(API_DIR, 'accounts', '[id]', 'route.ts'), 'PATCH'],
  ];

  it.each(ROUTES)(
    '%s のハンドラが ensurePluginsStartedAnonymously を await する',
    (_label, path, method) => {
      expect(existsSync(path), `${path} が無い`).toBe(true);
      const source = withoutComments(readFileSync(path, 'utf8'));

      expect(source, 'import が無い').toMatch(
        /import \{[^}]*ensurePluginsStartedAnonymously[^}]*\} from ['"]@\/plugin\/runtime['"]/,
      );
      expect(routeBlock(source, method), `${method} のハンドラで呼んでいない`).toMatch(
        /await ensurePluginsStartedAnonymously\(\)/,
      );
    },
  );

  /** 設計 §6.7 は `POST /social/publish` も挙げている（登録簿が空だと全件飛ばす）。 */
  it('POST /social/publish のハンドラも ensurePluginsStartedAnonymously を await する', () => {
    const source = withoutComments(readFileSync(join(API_DIR, 'publish', 'route.ts'), 'utf8'));

    expect(routeBlock(source, 'POST')).toMatch(/await ensurePluginsStartedAnonymously\(\)/);
  });
});
