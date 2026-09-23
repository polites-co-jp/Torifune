import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { JOB_NAMES } from '@/domain/jobs/job';
import { CORE_PERMISSIONS } from '@/domain/permission';
import {
  MANUAL_TIMEOUT_MS,
  PUBLISH_MAX_SKIPS,
  VALIDATE_TIMEOUT_MS,
  skipFailureReason,
} from '@/domain/social/publishing';
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
const MIGRATIONS_DIR = join(REPO_ROOT, 'migrations');

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
  const externalManual = readFileSync(join(DOCS_DIR, 'マニュアル', 'SNS投稿の外部連携.md'), 'utf8');

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

  // -------------------------------------------------------------------------
  // 2026-09-23 の改訂（設計 §12 の末尾 4 行）。
  //
  // 裁定 #10（検証レポート A-1）・検証レポート L-4・裁定 #9 を、
  // **読み手が事故を避けられる文言として**文書に固定する。実装は変えていないので、
  // これらの文が消えると文書だけが実装より甘くなる。
  // -------------------------------------------------------------------------

  /**
   * 裁定 #10 / 検証レポート A-1。**トークンは名前空間であって分離境界ではない**（設計 §8.1）。
   *
   * 「トークン 1 本 = 外部アプリ 1 つ」とだけ書かれたマニュアルを読んだ運用者が
   * 第三者のアプリへトークンを配ると、その第三者が他のアプリの投稿を書き換え、
   * 他のアカウントの資格情報を上書きできる。**この一文が消えることが事故の入口である。**
   */
  it('#81 マニュアルが「トークンは名前空間であって分離境界ではない」と書いている', () => {
    expect(externalManual).toMatch(/トークンは名前空間であって、分離境界ではない/);
    expect(externalManual).toContain('トークンを分けても、データは分かれない');
  });

  it.each([
    ['他のアプリの投稿が読めること', '本文ごと全件返る'],
    ['他のアプリの投稿を書き換えられること', 'B の SNS アカウントで任意の文章を公開できる'],
    ['他のアカウントの資格情報を上書きできること', 'B が登録した資格情報を上書き・削除できる'],
  ])('#81 マニュアルが %s を具体的に書いている', (_label, token) => {
    expect(externalManual).toContain(token);
  });

  it('#81 マニュアルが「信頼できない第三者のアプリへ渡さない」と書いている', () => {
    // 裁定 #10 が「マニュアルに書く」と決めた文そのもの。
    expect(externalManual).toContain('信頼できない第三者のアプリへ渡さない');
  });

  /**
   * #81（2026-09-23 に足した。検証レポート §9.2 の R-7）。
   * **マニュアルの Permission 名が実装と食い違わないこと。**
   *
   * 危険の説明として「取り消しもできる」と書いていたが、
   * `DELETE /api/v1/social/posts/{id}` の Permission は **`social.delete`** で、
   * **`social.write` だけのトークンでは通らない**（設計 §6.8 と `009-social`）。
   *
   * **できないことを「できる」と書くのは、危険の説明としても誤り**である。
   * 読んだ運用者が Scope の絞り込み（`social.delete` を外す）に意味が無いと受け取る。
   */
  describe('#81 マニュアルの Permission 名', () => {
    /** `<resource>.<read|write|delete|manage>` の形で書かれたもの。Event 名は拾わない。 */
    const PERMISSION_TOKEN = String.raw`\x60[a-z][a-z0-9_-]*\.(?:read|write|delete|manage)\x60`;

    /** その文に書かれた Permission 名（`g` フラグの状態を持ち回さないよう毎回作る）。 */
    function permissionsIn(text: string): readonly string[] {
      return [...text.matchAll(new RegExp(PERMISSION_TOKEN, 'g'))].map((match) =>
        match[0].replaceAll('`', ''),
      );
    }

    /** §「トークンは名前空間であって、分離境界ではない」の「できてしまうこと」の表。 */
    function capabilityRows(): readonly string[] {
      const start = externalManual.search(/^### トークンは名前空間であって、分離境界ではない$/m);
      expect(start, 'その節が無い').toBeGreaterThanOrEqual(0);
      // 見出しの行そのものを飛ばして、次の見出しまでを切り出す。
      const rest = externalManual.slice(externalManual.indexOf('\n', start) + 1);
      const end = rest.search(/^#{2,4} /m);
      const section = end === -1 ? rest : rest.slice(0, end);

      return (
        section
          .split('\n')
          .filter((row) => row.startsWith('| '))
          // 見出し行と区切り行を除く。
          .filter((row) => !/^\|[\s|-]+$/.test(row) && !row.startsWith('| できてしまうこと'))
      );
    }

    it('#81 マニュアルに書かれた Permission 名がすべて実在する', () => {
      const mentioned = permissionsIn(externalManual);

      expect(
        mentioned.length,
        'Permission 名が 1 つも見つからない（検査が空振り）',
      ).toBeGreaterThan(0);
      for (const name of new Set(mentioned)) {
        expect(CORE_PERMISSIONS as readonly string[], `${name} は permissions に無い`).toContain(
          name,
        );
      }
    });

    it('#81 「できてしまうこと」の各行に Permission 名が併記されている', () => {
      const rows = capabilityRows();

      expect(rows.length, '表の行が読み取れない').toBeGreaterThanOrEqual(4);
      for (const row of rows) {
        expect(permissionsIn(row), `Permission 名の無い行: ${row}`).not.toHaveLength(0);
      }
    });

    /**
     * #81。**`social.write` を持つトークンにできる、として挙げた操作の Permission は
     * その一覧（`social.read` / `social.write`）に含まれる。**
     */
    it('#81 できると書いた行の Permission が social.read / social.write に収まる', () => {
      const allowed = new Set(['social.read', 'social.write']);

      for (const row of capabilityRows()) {
        if (row.includes('このトークンには無い')) continue;
        for (const name of permissionsIn(row)) {
          expect(allowed, `${name} は social.write のトークンには無い: ${row}`).toContain(name);
        }
      }
    });

    /**
     * #81 の要。**`social.write` でできると書いてよいのは `social.read` / `social.write` の操作だけ。**
     * `social.delete` を要する行は「このトークンには無い」と明記する。
     */
    it('#81 social.delete を要する行は「このトークンには無い」と書かれている', () => {
      for (const row of capabilityRows().filter((row) => row.includes('`social.delete`'))) {
        expect(row, `social.delete の行に断りが無い: ${row}`).toContain('このトークンには無い');
      }
    });

    it('#81 DELETE の行が social.delete を要ると書いている', () => {
      const row = capabilityRows().find((line) => line.includes('DELETE /api/v1/social/posts'));

      expect(row, 'DELETE を挙げた行が無い').toBeDefined();
      expect(row).toContain('`social.delete`');
    });

    it('#81 まとめの文が「取り消し」をできることに数えていない', () => {
      // 訂正前の文。残っていると実装と食い違う。
      expect(externalManual).not.toContain('他のアプリが登録した投稿の閲覧・書き換え・取り消し');
    });

    it('#81 まとめの文が訂正後の形になっている', () => {
      expect(externalManual).toContain('他のアプリが登録した投稿の閲覧・書き換えと、');
      expect(externalManual).toContain('他のアカウントの資格情報の上書きができる');
      expect(externalManual).toContain('取り消しには `social.delete` が別に要る');
    });
  });

  /**
   * 設計 §11 #21（裁定 #12-a の代償）。
   * **支度待ちの投稿を「いますぐ出す」には未来の日時を指定する。**
   *
   * 過去日時への予約し直しでは `next_attempt_at` が戻らないので、
   * 最大 23 時間待たされる。**画面のフォームとマニュアルで案内する**と設計が決めた。
   * 案内が無いと、運用者は「直したのに出ない」を原因不明のまま踏む。
   */
  describe('§11 #21 いますぐ出したいときの案内（マニュアル）', () => {
    it('§11 #21 マニュアルが「数分後の日時」を指定するよう案内している', () => {
      expect(externalManual).toContain('数分後の日時');
    });

    it('§11 #21 マニュアルが「いますぐ出したいとき」の場面を書いている', () => {
      expect(externalManual).toContain('いますぐ出したいとき');
    });

    it('§11 #21 マニュアルが過去の日時では待ち時刻が消えないと書いている', () => {
      expect(externalManual).toContain('過去の日時');
      expect(externalManual).toContain('nextAttemptAt');
    });
  });

  /**
   * #81（2026-09-23 に足した。4 回目の検証の軽-3）。
   * **裁定 #14 が §12 でマニュアルへ書くと決めた文言**（設計 §12 の末尾 2 行、§11 #24）。
   *
   * 裁定 #9 / #10 と検証レポート L-4 のぶんは固定してあるのに、**裁定 #14 のぶんだけ抜けていた**。
   * この段落が消えても落ちるテストが 1 件も無く、**運用者が「日時を直したのだから
   * また丸一日待ってもらえる」と読み違える**——その状態が検知されないまま残る。
   *
   * 待ち時刻が消える条件は、裁定 #13-a の「**先送りしたときだけ**」へ巻き戻っても
   * 実装の側では誰も気づかない（§6.2 から差分の判定を外したのは裁定 #14）。
   * **文言のほうでそれを固定する。**
   */
  describe('#81 マニュアルの裁定 #14（予約し直しの代償）', () => {
    it('#81 マニュアルが「予約し直しでは飛ばされた回数が減らない」と書いている', () => {
      expect(externalManual).toContain('予約し直しても、飛ばされた回数は減らない');
      // 消えるのは待ち時刻だけ、が裁定 #14-a の要（設計 §11 #24）。
      expect(externalManual).toContain('消えるのは**待ち時刻だけ**');
    });

    it('#81 マニュアルが「飛ばされた回数は予約日時を直しても減らない」と箇条書きでも書いている', () => {
      expect(externalManual).toContain('予約し直しでは数え直さない');
      expect(externalManual).toContain('飛ばされた回数は予約日時を直しても減らない');
    });

    it('#81 マニュアルが「2 回飛ばされた投稿は次の 1 回で failed」と書いている', () => {
      expect(externalManual).toContain(
        '2 回飛ばされた投稿は、支度が整わないまま日時を直しても次の 1 回で取りやめ（`failed`）',
      );
    });

    /**
     * **裁定 #13-a への巻き戻りを検知する。** 待ち時刻が消える条件は
     * 「予約日時が現在時刻より未来へ変わったとき」の 1 つで、**向きを問わない**（裁定 #14）。
     */
    it('#81 マニュアルが「先送りでも手前へ引き戻すのでも変わらない」と書いている', () => {
      expect(externalManual).toContain('予約日時が「現在時刻より未来」へ変わったとき');
      expect(externalManual).toContain('先送りでも手前へ引き戻すのでも変わらない');
    });

    it('#81 マニュアルが「支度を整えてから直せば配信される」と書いている', () => {
      // 代償（§11 #24）だけを書くと「もう出せない」と読まれる。逃げ道を同じ段落に置く。
      expect(externalManual).toContain('整えてから日時を直せば、その時刻に配信される');
      expect(externalManual).toContain('一度でも配信に着手できた時点で回数は 0 に戻る');
    });
  });

  /**
   * 検証レポート L-4。冪等キーは `(created_by_token_id, external_ref)` なので、
   * **トークンを差し替えると名前空間が黙って変わる。**
   */
  it('#81 マニュアルがトークンの差し替えで冪等キーの名前空間が変わると書いている', () => {
    expect(externalManual).toContain('冪等キーの名前空間が黙って変わる');
    expect(externalManual).toContain('SNS には同じ内容が 2 回出る');
  });

  it('#81 マニュアルが「未確定の登録が無い時点で差し替える」と書いている', () => {
    expect(externalManual).toContain('未確定の登録が無い時点で差し替える');
  });

  /**
   * 裁定 #9。**支度が整わない予約は約 24 時間で `failed`。**
   * `failureReason` は Domain が組み立てた文字列がそのまま外部アプリへ出るので、
   * **実装の文言と突き合わせる**（どちらかだけ直すと案内が嘘になる）。
   */
  it('#81 マニュアルが「支度が整わない予約は約 24 時間で取りやめ」と書いている', () => {
    expect(externalManual).toContain('待つのは約 24 時間まで');
    expect(externalManual).toContain('3 回飛ばした時点で取りやめ');
  });

  it.each([
    ['配信 Plugin が無いとき', 'no_publisher' as const],
    ['資格情報が未設定のとき', 'credential_missing' as const],
  ])('#81 マニュアルに %s の failureReason が実装どおり載っている', (_label, reason) => {
    expect(externalManual).toContain(skipFailureReason(reason));
  });

  it('#81 マニュアルが「failed は終端。新しい投稿として登録し直す」と書いている', () => {
    expect(externalManual).toContain('`failed` は終端。支度が整っても自動では戻らない');
    expect(externalManual).toContain('新しい投稿として登録し直す');
  });

  it('#81 マニュアルの「状態の読み方」に支度待ちの行がある', () => {
    const line = externalManual.split('\n').find((row) => row.startsWith('| **支度待ち** |'));

    expect(line, '「支度待ち」の行が無い').toBeDefined();
    // 再試行待ちとの見分けは `failureReason` が空かどうか（skipCount は API に出ない）。
    expect(line).toContain('failureReason');
  });

  /**
   * 検証レポート L-1 の始末。**伏せ字は機構であって契約ではない。**
   * 「完全一致の 4 文字以上しか消せない」を落とすと、
   * Plugin 作者が伏せ字を当てにして値を渡す。
   */
  it('#81 Plugin開発ガイドが logger の伏せ字の限界（4 文字以上の完全一致）を書いている', () => {
    expect(guide).toContain('4 文字以上の値');
    expect(guide).toContain('そのままの形で');
    expect(guide).toContain('伏せる仕掛けを当てにせず、値を渡さない');
  });

  /**
   * 検証レポート L-3。`validate()` / `manual()` の制限時間（設計 §6.6）。
   *
   * **「呼ばれる場面と制限時間」の表だけを見る。** 同じ `| \`validate\` |` で始まる行は
   * 直前の「役割」の表にもあり、文書全体から探すと常にそちらが先に当たってしまう。
   */
  it.each([
    ['validate', VALIDATE_TIMEOUT_MS],
    ['manual', MANUAL_TIMEOUT_MS],
  ])('#81 Plugin開発ガイドの制限時間の表で %s の上限が実装と合っている', (name, timeoutMs) => {
    const start = guide.search(/^#### 呼ばれる場面と制限時間$/m);
    expect(start, '「呼ばれる場面と制限時間」の節が無い').toBeGreaterThanOrEqual(0);
    const rest = guide.slice(start + 1);
    const end = rest.search(/^#### /m);
    const section = end === -1 ? rest : rest.slice(0, end);

    const line = section.split('\n').find((row) => row.startsWith(`| \`${name}\` |`));

    expect(line, `${name} の行が無い`).toBeDefined();
    expect(line).toContain(`**${timeoutMs / 1000} 秒**`);
  });

  /** 検証レポート S-2。publisher が無い間に登録された投稿は配信直前が唯一の判定機会。 */
  it('#81 Plugin開発ガイドが「limits / validate は配信直前にも掛かる」と書いている', () => {
    expect(guide).toContain('配信直前にももう一度掛かる');
    expect(guide).toContain('配信直前が唯一の判定機会');
  });

  /** 裁定 #9 を Plugin 作者の側からも読めるようにする。 */
  it('#81 Plugin開発ガイドが「支度が整わない予約は約 24 時間で failed」と書いている', () => {
    expect(guide).toContain('待つのは約 24 時間まで');
    expect(guide).toMatch(/予約時刻からおよそ 24 時間で `failed`/);
    expect(guide).toContain(`同じ理由で ${PUBLISH_MAX_SKIPS} 回飛ばした時点`);
  });

  /** 設計 §7.9。**宣言が導入前に見えるところまでが 035 の責任。** */
  it('#81 Plugin開発ガイドが extensions は導入前の Plugin マネージャに出ると書いている', () => {
    expect(guide).toContain('導入前の Plugin マネージャ');
    expect(guide).toContain('SNS配信（SNSアカウントの資格情報を受け取ります）');
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
 *
 * **2026-09-23 に対象を足した（検証レポート §4 の 3、#84 の書き直し）。**
 * `social-use-cases.ts` の `validate()`（設計 §6.1.2 の m）と `manual()`（§6.6）の
 * 例外メッセージが `redactSecrets` を通らずログへ出ていた。**条件違反ではなかった**
 * （検査対象の 3 ファイルに入っていなかった）が、#84 の見出しは「**すべて**」と書いている。
 * 見出しが言っていることを条件が保証していないなら、**直すべきは条件のほうである。**
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
    [
      'application/social/social-use-cases.ts',
      join(SRC_DIR, 'application', 'social', 'social-use-cases.ts'),
    ],
  ])('#84 %s が redactSecrets を通し、生の message を reason にしていない', (_label, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source, 'redactSecrets を使っていない').toContain('redactSecrets');
    expect(source, '生の message をそのまま reason にしている').not.toMatch(RAW_REASON);
    expect(source, '生の message をそのまま reason にしている').not.toMatch(RAW_MESSAGE);
  });

  it('#84 social-use-cases.ts が reason を出している（検査が空振りしていない）', () => {
    // `validate()`（設計 §6.1.2 の m）と `manual()`（§6.6）の失敗をログに残す経路。
    // 出していないなら、この検査は何も守っていない。
    const source = withoutComments(
      readFileSync(join(SRC_DIR, 'application', 'social', 'social-use-cases.ts'), 'utf8'),
    );

    expect(source).toMatch(/reason:/);
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
 * #85 の (E)。**マイグレーションと Domain の列挙が食い違わないこと**（設計 §5.1.1）。
 *
 * `skip_reason` は DB の CHECK と Domain の `SkipReason` の 2 か所に書かれる。
 * 片方だけ増やすと、書けない値を Application が作るか、Domain の知らない値が
 * DB に入る。**どちらも静的に検出できる。**
 *
 * `022` は適用済みなので、内容が変わっていないことも併せて固定する
 * （前進のみのランナーは、適用済みのファイルを書き換えても当て直さない）。
 */
describe('#85 023 のマイグレーションと Domain の列挙', () => {
  /** リポジトリのマイグレーションを読む（改行コードの違いを吸収する）。 */
  function migrationSource(name: string): string {
    const path = join(MIGRATIONS_DIR, name);
    expect(existsSync(path), `migrations/${name} が無い`).toBe(true);
    return readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  }

  /**
   * `022_social_publishing.sql` の内容（改行を LF にそろえたもの）の SHA-256。
   *
   * 2026-09-23 に裁定 #9 を入れる前の版。**適用済みなので書き換えない。**
   * 足りない列は `023` で足す。
   */
  const SHA256_OF_022 = '71ce89e8c855bdb2df3e370f84f67e4b61e913c6fbf325e826b12eef75dede01';

  it('#85 022_social_publishing.sql のファイル内容が変わっていない', () => {
    const digest = createHash('sha256')
      .update(migrationSource('022_social_publishing.sql'), 'utf8')
      .digest('hex');

    expect(
      digest,
      '022 は適用済み。足りない列は 023_social_publish_skip.sql で足す（設計 §5.1.1）',
    ).toBe(SHA256_OF_022);
  });

  it('#85 023_social_publish_skip.sql がある', () => {
    expect(existsSync(join(MIGRATIONS_DIR, '023_social_publish_skip.sql'))).toBe(true);
  });

  /**
   * #116 の (E)（2026-09-23 に足した。3 回目の検証、裁定 #13-b の低-C）。
   *
   * `023` も適用済みになったので、`022` と同じ形で固定する。
   * 走査の索引は `024_social_posts_due_index.sql` で足す（設計 §5.1.2）。
   */
  const SHA256_OF_023 = 'db24dcf1c2510d1dffd158dda04384faa33bcdc3e9920299772aba0af3485c29';

  it('#116 023_social_publish_skip.sql のファイル内容が変わっていない', () => {
    const digest = createHash('sha256')
      .update(migrationSource('023_social_publish_skip.sql'), 'utf8')
      .digest('hex');

    expect(
      digest,
      '023 は適用済み。足りない索引は 024_social_posts_due_index.sql で足す（設計 §5.1.2）',
    ).toBe(SHA256_OF_023);
  });

  it('#85 SKIP_REASONS の値の集合が 023 の CHECK に書かれた値と一致する', async () => {
    // **静的 import にしない。** 未実装の段階でこのファイル全体が読めなくなると、
    // 既存の静的検査（#59 / #81〜#84）まで一緒に落ちて、何が壊れたのか読めなくなる。
    const domain = (await import('@/domain/social/publishing')) as {
      readonly SKIP_REASONS?: readonly string[];
    };
    const source = migrationSource('023_social_publish_skip.sql');
    const clause = /skip_reason\s+IN\s*\(([^)]*)\)/i.exec(source);

    expect(clause, '023 に skip_reason の CHECK が無い').not.toBeNull();
    const inSql = [...(clause?.[1] ?? '').matchAll(/'([^']*)'/g)].map((match) => match[1]).sort();

    expect(inSql.length, 'CHECK から値を読み取れない').toBeGreaterThan(0);
    expect([...(domain.SKIP_REASONS ?? [])].sort()).toEqual(inSql);
  });
});

/**
 * #87 の (E)。**判定の二重実装が無いこと**（設計 §5.6.2 / §6.1.2 の枠）。
 *
 * `limits` の判定を登録時と配信直前で別々に書くと、片方だけ直したときに
 * 「登録では弾かれるのに配信では通る」が黙って生まれる。**同じ 1 つの関数を使う。**
 */
describe('#87 limits の判定を 1 か所に持つ', () => {
  it.each([
    [
      'application/social/social-use-cases.ts',
      join(SRC_DIR, 'application', 'social', 'social-use-cases.ts'),
    ],
    ['application/social/publish.ts', join(SRC_DIR, 'application', 'social', 'publish.ts')],
  ])('#87 %s が checkPublisherLimits を使っている', (_label, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));

    expect(source).toContain('checkPublisherLimits');
  });
});

/**
 * #87 の (E)（2026-09-23 に足した。検証レポート §9.2 の R-10）。
 *
 * **`PublisherLimits` のキーの集合と、`checkPublisherLimits` が判定に使うキーの集合が一致する。**
 *
 * 前の (E) は「同じ関数を使う」ことしか見ておらず、`PublisherLimits` に項目を増やしても
 * **どのテストも落ちない**。効かない宣言は、Plugin 側からは
 * 「宣言したのに守られない」という最も気づきにくい壊れ方をする（設計 §9.2 のコメント）。
 */
describe('#87 PublisherLimits の宣言と判定が一致する', () => {
  const EXPECTED = ['bodyMaxLength', 'mediaMax', 'mediaRequired'];

  /** `packages/plugin-api/src/social.ts` の `interface PublisherLimits { … }` の中身。 */
  function declaredKeys(): readonly string[] {
    const path = join(REPO_ROOT, 'packages', 'plugin-api', 'src', 'social.ts');
    const source = readFileSync(path, 'utf8');
    const start = source.search(/^export interface PublisherLimits \{$/m);
    expect(start, 'PublisherLimits の宣言が無い').toBeGreaterThanOrEqual(0);
    const rest = source.slice(start);
    const end = rest.search(/^\}/m);
    expect(end, 'PublisherLimits の終わりが読めない').toBeGreaterThan(0);
    const body = withoutComments(rest.slice(0, end));

    return [...body.matchAll(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/gm)]
      .map((match) => match[1] as string)
      .sort();
  }

  /** `domain/social/publishing.ts` の `checkPublisherLimits` が読む `limits.<key>`。 */
  function judgedKeys(): readonly string[] {
    const source = readFileSync(join(SRC_DIR, 'domain', 'social', 'publishing.ts'), 'utf8');
    const start = source.search(/^export function checkPublisherLimits\(/m);
    expect(start, 'checkPublisherLimits が無い').toBeGreaterThanOrEqual(0);
    const rest = source.slice(start);
    const end = rest.search(/^\}/m);
    expect(end, 'checkPublisherLimits の終わりが読めない').toBeGreaterThan(0);
    const body = withoutComments(rest.slice(0, end));

    return [
      ...new Set(
        [...body.matchAll(/\blimits\.([A-Za-z_$][\w$]*)/g)].map((match) => match[1] as string),
      ),
    ].sort();
  }

  it('#87 PublisherLimits のキーが読み取れる（検査が空振りしていない）', () => {
    expect(declaredKeys()).toEqual(EXPECTED);
  });

  it('#87 checkPublisherLimits が判定に使うキーが読み取れる', () => {
    expect(judgedKeys()).toEqual(EXPECTED);
  });

  /** **宣言だけ足して Domain が黙って無視する状態を作れない。** */
  it('#87 宣言と判定のキーの集合が一致する', () => {
    expect(judgedKeys(), 'PublisherLimits に足したキーを Domain が見ていない').toEqual(
      declaredKeys(),
    );
  });
});

/**
 * #105 の (e)（設計 §6.6。裁定 #12-c）。
 *
 * **締切は 1 回だけ作って `Promise.all` の全行へ渡す。**
 * 行ごとに作り直すと、締切が「1 行あたり 10 秒」になって描画全体の上限が消える。
 * **同一プロセスの結合テストでは呼ぶ側の形を見られない**ので、ここが唯一の固定になる。
 */
describe('#105 (e) 締切の作り方（app/social/page.tsx）', () => {
  const PAGE = join(SRC_DIR, 'app', 'social', 'page.tsx');

  function pageSource(): string {
    expect(existsSync(PAGE), 'app/social/page.tsx が無い').toBe(true);
    return withoutComments(readFileSync(PAGE, 'utf8'));
  }

  /** `new Date(now.getTime() + MANUAL_HANDOFF_BUDGET_MS)` のような形（`)` をまたぐ）。 */
  const DEADLINE = /new Date\([^;]*MANUAL_HANDOFF_BUDGET_MS/;

  it('#105 (e) MANUAL_HANDOFF_BUDGET_MS から締切を作っている', () => {
    expect(pageSource()).toMatch(DEADLINE);
  });

  it('#105 (e) 締切を作るのは 1 か所だけ（行ごとに作り直していない）', () => {
    const matches = pageSource().match(new RegExp(DEADLINE.source, 'g')) ?? [];

    expect(matches, '締切を複数回作っている').toHaveLength(1);
  });

  it('#105 (e) 行ごとの呼び出しは Promise.all で並行に行う', () => {
    const source = pageSource();

    expect(source).toContain('Promise.all');
    expect(source).toMatch(/resolveManualHandoff\(/);
  });

  it('#105 (e) resolveManualHandoff に deadline を渡している', () => {
    expect(pageSource()).toMatch(/resolveManualHandoff\([\s\S]{0,200}?deadline/);
  });

  it('#105 (e) 締切は Promise.all より前に作られている', () => {
    const source = pageSource();
    const deadlineAt = source.search(DEADLINE);
    const mapAt = source.indexOf('Promise.all');

    expect(deadlineAt, '締切を作っていない').toBeGreaterThanOrEqual(0);
    expect(mapAt, 'Promise.all が無い').toBeGreaterThanOrEqual(0);
    expect(deadlineAt, '締切を Promise.all の中で作っている').toBeLessThan(mapAt);
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
