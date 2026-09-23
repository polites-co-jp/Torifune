import type { PublisherRegistration } from '@torifune/plugin-api';
import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { SOCIAL_PUBLISH_JOB } from '@/application/jobs/definitions';
import { runJob } from '@/application/jobs/run-job';
import { publishDuePosts } from '@/application/social/publish';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  updateSocialAccount,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { CREDENTIAL_UNREADABLE_REASON } from '@/domain/social/publishing';
import { decryptSecret, encryptSecret } from '@/infrastructure/crypto/cipher';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 資格情報の受け渡しと秘匿
 * （035-social-publishing 設計 §6.5.5 / §6.5.6 / §6.5.8、受け入れ条件 #27(B)、#52、#53、#55）。
 *
 * **「まだ設定していない」と「壊れている」を分ける**（要件 §4 裁定 #8）。
 * 未設定は `failed` にせず飛ばして待つ（着手印すら書かない）。
 * 復号できない・宣言と形が合わないものだけが `failed`。
 *
 * #55 は「Core が Plugin へ渡した値そのもの」が、ログ・`job_runs`・
 * `failure_reason`・`audit_logs` のどこにも現れないことを見る（実装プラン §7 の 8）。
 */

const PLUGIN_ID = 'test-plugin';
const PROVIDER = 'testsns';
const CREDENTIAL_FIELDS = [
  { key: 'identifier', label: '識別子', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
] as const;

type PublishFn = NonNullable<PublisherRegistration['publish']>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `crd${suffix}`,
        email: `crd${suffix}@example.com`,
        display_name: 'publish credential test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `crd${suffix}`,
    displayName: 'publish credential test',
    email: `crd${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

function usePublisher(
  publish: PublishFn,
  overrides: Partial<PublisherRegistration> = {},
): ReturnType<typeof vi.fn<PublishFn>> {
  const mock = vi.fn<PublishFn>(publish);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [...CREDENTIAL_FIELDS],
    publish: mock,
    ...overrides,
  });
  return mock;
}

interface AccountOptions {
  readonly credential?: string | null;
  readonly credentials?: Readonly<Record<string, string>>;
}

async function accountFor(options: AccountOptions = {}): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider: PROVIDER,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: options.credential ?? null,
    ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    status: 'connected',
  });
  return account.id;
}

async function makePost(accountId: string, body = '配信される本文'): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body,
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

interface PostRow {
  readonly status: string;
  readonly failure_reason: string | null;
  readonly publish_started_at: Date | null;
  readonly attempt_count: number;
}

async function postRow(id: string): Promise<PostRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status', 'failure_reason', 'publish_started_at', 'attempt_count'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as PostRow;
}

/**
 * 後ろへ送った痕跡（`023_social_publish_skip.sql`。設計 §5.1.1）。
 *
 * `postRow` とは分けておく。**既存の条件を見るテストに新しい列を混ぜない**ため。
 */
interface SkipRow {
  readonly skip_count: number;
  readonly skip_reason: string | null;
  readonly next_attempt_at: Date | null;
}

async function skipRow(id: string): Promise<SkipRow> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['skip_count', 'skip_reason', 'next_attempt_at'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row as SkipRow;
}

/** 後ろへ送られた予定を過去へ戻す（実時間で待たないため）。 */
async function rewindNextAttempt(id: string): Promise<void> {
  await withConnection(async (connection) => {
    await connection.db
      .updateTable('social_posts')
      .set({ next_attempt_at: new Date(Date.now() - 1_000) })
      .where('id', '=', id)
      .execute();
  });
}

/** 予約時刻が「今から delayMs 後」であること（±5 秒）。 */
function expectDelay(nextAttemptAt: Date | null, delayMs: number): void {
  expect(nextAttemptAt).toBeInstanceOf(Date);
  const diff = (nextAttemptAt?.getTime() ?? 0) - Date.now();
  expect(diff, `次の予約が ${delayMs}ms 後ではない（${diff}ms）`).toBeGreaterThan(delayMs - 5_000);
  expect(diff, `次の予約が ${delayMs}ms 後ではない（${diff}ms）`).toBeLessThan(delayMs + 5_000);
}

async function storedCredential(accountId: string): Promise<string | null> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential'])
      .where('id', '=', accountId)
      .executeTakeFirst(),
  );
  return (row as { credential: string | null } | undefined)?.credential ?? null;
}

async function auditRows(action: string): Promise<
  {
    readonly resource_type: string;
    readonly resource_id: string | null;
    readonly detail: Record<string, unknown>;
  }[]
> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['resource_type', 'resource_id', 'detail'])
      .where('action', '=', action)
      .execute();
    return rows as {
      readonly resource_type: string;
      readonly resource_id: string | null;
      readonly detail: Record<string, unknown>;
    }[];
  });
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishcred');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('api_tokens').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

/**
 * #27(B) / #52 の前半。**資格情報がまだ設定されていない投稿は後ろへ送って待つ**
 * （要件 §4 裁定 #8・#9、設計 §6.5.2 の a / §6.5.2.1）。
 *
 * 予約の時点では断らない（#27 の C）。断らずに受けた以上、配信の支度が
 * 整うまで**待たせる**のが筋で、その場で `failed` にして捨てるのは裁定に反する。
 * **着手印は書かない**ので `attempt_count` は 0 のままになる。
 *
 * > **2026-09-23 に書き直した（裁定 #9）。** もとの条件は「**行に触らない**」だった。
 * > 触らないと、飛ばした行が取り出しの先頭に居座り続けて他のアカウントの配信まで止まる
 * > （検証レポート S-1）。「触らない」を「**後ろへ送る**」に改める。
 * > **`attempt_count = 0`・着手印なし・`failure_reason` を書かない・
 * > 支度が整えば配信される、という保証はすべて残す。**
 * > 同じ理由で 3 回飛ばされたら `failed` になることは #90 が見る。
 */
describe('#27(B) #52 資格情報が未設定の投稿は後ろへ送って待つ', () => {
  async function unconfigured(): Promise<{
    readonly accountId: string;
    readonly postId: string;
    readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
    readonly summary: Awaited<ReturnType<typeof run>>;
  }> {
    const publish = usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    const summary = await run();
    return { accountId, postId, publish, summary };
  }

  it('#27(B) 投稿は scheduled のまま', async () => {
    const { postId } = await unconfigured();

    expect((await postRow(postId)).status).toBe('scheduled');
  });

  it('#27(B) attempt_count が 0 のまま（着手印を書かない）', async () => {
    // b まで進めてから戻すと、`attempt_count` を無駄に減らせない（設計 §6.5.2 の a）。
    const { postId } = await unconfigured();

    expect((await postRow(postId)).attempt_count).toBe(0);
  });

  it('#27(B) publish_started_at が NULL のまま', async () => {
    // 消し忘れた行は次の実行で「中断」として failed になる（設計 §6.5.4）。
    const { postId } = await unconfigured();

    expect((await postRow(postId)).publish_started_at).toBeNull();
  });

  it('#27(B) summary の skipped が 1 で failed も skipFailed も 0', async () => {
    const { summary } = await unconfigured();

    expect(summary).toMatchObject({
      due: 1,
      skipped: 1,
      skipFailed: 0,
      attempted: 0,
      failed: 0,
    });
  });

  it('#27(B) skip_count = 1 / skip_reason = credential_missing が書かれる', async () => {
    // **「まだ用意していない」を理由として記録する。** `attempt_count` に混ぜない
    // （あれは `publish()` を呼んだ回数。裁定 #9 の細目）。
    const { postId } = await unconfigured();
    const row = await skipRow(postId);

    expect(row.skip_count).toBe(1);
    expect(row.skip_reason).toBe('credential_missing');
  });

  it('#27(B) next_attempt_at がおよそ 1 時間後になる（後ろへ送る）', async () => {
    const { postId } = await unconfigured();

    expectDelay((await skipRow(postId)).next_attempt_at, 60 * 60_000);
  });

  it('#52 publish() は呼ばれない', async () => {
    const { publish } = await unconfigured();

    expect(publish).not.toHaveBeenCalled();
  });

  it('#52 audit_logs に credential_read が増えない', async () => {
    // 読んでいないものを「読んだ」と記録しない。
    await unconfigured();

    expect(await auditRows('credential_read')).toHaveLength(0);
  });

  it('#27(B) failure_reason を書かない', async () => {
    const { postId } = await unconfigured();

    expect((await postRow(postId)).failure_reason).toBeNull();
  });

  it('#27(B) 資格情報を設定して再実行すると published になる', async () => {
    // **裁定 #8 の要。** 後ろへ送った投稿は、支度が整えばそのまま配信される。
    const { accountId, postId, publish } = await unconfigured();

    await updateSocialAccount(admin, {
      id: accountId,
      credentials: { identifier: 'id-a1b2', appPassword: 'pw-c3d4' },
    });
    await rewindNextAttempt(postId);
    await run();

    expect((await postRow(postId)).status).toBe('published');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('#27(B) 配信できた投稿は skip_count が 0・skip_reason が NULL に戻る', async () => {
    const { accountId, postId } = await unconfigured();

    await updateSocialAccount(admin, {
      id: accountId,
      credentials: { identifier: 'id-a1b2', appPassword: 'pw-c3d4' },
    });
    await rewindNextAttempt(postId);
    await run();

    const row = await skipRow(postId);
    expect(row.skip_count).toBe(0);
    expect(row.skip_reason).toBeNull();
  });

  it('#27(B) 設定後の publish() は登録した資格情報を受け取る', async () => {
    const { accountId, postId, publish } = await unconfigured();

    await updateSocialAccount(admin, {
      id: accountId,
      credentials: { identifier: 'id-a1b2', appPassword: 'pw-c3d4' },
    });
    await rewindNextAttempt(postId);
    await run();

    expect(publish.mock.calls[0]?.[0].credential).toEqual({
      identifier: 'id-a1b2',
      appPassword: 'pw-c3d4',
    });
  });
});

/**
 * #52 の後半。**壊れている資格情報は従来どおり `failed`**（設計 §6.5.2 の c）。
 *
 * 「設定されているのに使えない」は待っても直らない。人が登録し直す必要がある。
 */
describe('#52 資格情報が壊れているときは failed', () => {
  it('#52 自由文字列の資格情報は failed になる', async () => {
    // 自由文字列で登録済みのアカウントに、後から Plugin を入れた場合（設計 §5.7）。
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor({ credential: 'legacy' });
    const postId = await makePost(accountId);

    await run();

    expect((await postRow(postId)).status).toBe('failed');
  });

  it('#52 その理由に要求するキー名が並ぶ', async () => {
    // 理由文に要求するキー名を書くので、運用者は登録し直せば直る。
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor({ credential: 'legacy' });
    const postId = await makePost(accountId);

    await run();

    expect((await postRow(postId)).failure_reason).toContain('identifier, appPassword');
  });

  it('#52 形が合わないとき publish() は呼ばれない', async () => {
    const publish = usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor({ credential: 'legacy' });
    await makePost(accountId);

    await run();

    expect(publish).not.toHaveBeenCalled();
  });

  it('#52 別の鍵で暗号化された資格情報は CREDENTIAL_UNREADABLE_REASON で failed', async () => {
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor({ credentials: { identifier: 'a', appPassword: 'b' } });
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_accounts')
        .set({
          credential: encryptSecret(
            JSON.stringify({ identifier: 'id-other', appPassword: 'pw-other' }),
            {
              id: 'k9',
              material: randomBytes(32),
            },
          ),
        })
        .where('id', '=', accountId)
        .execute();
    });
    const postId = await makePost(accountId);

    await run();

    const row = await postRow(postId);
    expect(row.status).toBe('failed');
    expect(row.failure_reason).toBe(CREDENTIAL_UNREADABLE_REASON);
  });

  it('#52 復号できないときのログに資格情報の平文が出ない', async () => {
    const { records } = capture();
    usePublisher(async () => ({ ok: true }));
    const accountId = await accountFor({ credentials: { identifier: 'a', appPassword: 'b' } });
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_accounts')
        .set({
          credential: encryptSecret(
            JSON.stringify({ identifier: 'id-other', appPassword: 'pw-other' }),
            {
              id: 'k9',
              material: randomBytes(32),
            },
          ),
        })
        .where('id', '=', accountId)
        .execute();
    });
    await makePost(accountId);

    await run();

    const text = JSON.stringify(records);
    expect(text).not.toContain('pw-other');
    expect(text).not.toContain('id-other');
  });

  it('#52 credentialFields が空の publisher は credential が無くても呼ばれる', async () => {
    // 資格情報の要らない配信手段（設計 §5.7）。
    const publish = usePublisher(async () => ({ ok: true }), { credentialFields: [] });
    const accountId = await accountFor();
    const postId = await makePost(accountId);

    await run();

    expect(publish).toHaveBeenCalledTimes(1);
    expect((await postRow(postId)).status).toBe('published');
  });

  it('#52 credentialFields が空なら publish() は credential: {} を受け取る', async () => {
    const publish = usePublisher(async () => ({ ok: true }), { credentialFields: [] });
    const accountId = await accountFor();
    await makePost(accountId);

    await run();

    expect(publish.mock.calls[0]?.[0].credential).toEqual({});
  });
});

/** #53。`rotatedCredential` の書き戻し（設計 §6.5.6）。 */
describe('#53 rotatedCredential', () => {
  async function rotate(
    rotatedCredential: Readonly<Record<string, string>>,
  ): Promise<{ readonly accountId: string; readonly postId: string }> {
    usePublisher(async () => ({ ok: true, rotatedCredential }));
    const accountId = await accountFor({ credentials: { identifier: 'a', appPassword: 'b' } });
    const postId = await makePost(accountId);

    await run();
    return { accountId, postId };
  }

  it('#53 social_accounts.credential が新しい値に更新される', async () => {
    const { accountId } = await rotate({ identifier: 'a', appPassword: 'new' });

    const stored = await storedCredential(accountId);
    const decrypted = decryptSecret(stored ?? '');
    expect(decrypted.ok).toBe(true);
    expect(JSON.parse(decrypted.ok ? decrypted.secret.expose() : 'null')).toEqual({
      identifier: 'a',
      appPassword: 'new',
    });
  });

  it('#53 audit_logs に updated / social_account の行が残る', async () => {
    const { accountId } = await rotate({ identifier: 'a', appPassword: 'new' });

    const rows = (await auditRows('updated')).filter(
      (row) => row.resource_type === 'social_account',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(accountId);
  });

  it('#53 その detail が changed / rotated / pluginId', async () => {
    await rotate({ identifier: 'a', appPassword: 'new' });

    const rows = (await auditRows('updated')).filter(
      (row) => row.resource_type === 'social_account',
    );
    expect(rows[0]?.detail).toEqual({
      changed: ['credential'],
      rotated: true,
      pluginId: PLUGIN_ID,
    });
  });

  it('#53 宣言に合わない rotatedCredential では資格情報が書き換わらない', async () => {
    const { accountId } = await rotate({ only: 'x' });

    const stored = await storedCredential(accountId);
    const decrypted = decryptSecret(stored ?? '');
    expect(JSON.parse(decrypted.ok ? decrypted.secret.expose() : 'null')).toEqual({
      identifier: 'a',
      appPassword: 'b',
    });
  });

  it('#53 宣言に合わないときは level: warn のログが出る', async () => {
    const { records } = capture();
    usePublisher(async () => ({ ok: true, rotatedCredential: { only: 'x' } }));
    const accountId = await accountFor({ credentials: { identifier: 'a', appPassword: 'b' } });
    await makePost(accountId);

    await run();

    expect(records.some((record) => record.level === 'warn')).toBe(true);
  });

  it('#53 宣言に合わなくても投稿の結果は published のまま', async () => {
    // トークンの更新に失敗しても、送れた事実は変わらない。
    const { postId } = await rotate({ only: 'x' });

    expect((await postRow(postId)).status).toBe('published');
  });
});

/**
 * #55。**平文を出さない**（設計 §6.5.5、受け入れ条件 #55）。
 *
 * Plugin が返した自由文は `redactCredentialValues(redactSecrets(text), values)` →
 * `normalizeFailureReason` の順で通す（**伏せてから切る**）。
 * 本文・`PublishInput`・資格情報はログの `fields` に入れない。
 */
describe('#55 資格情報と本文がどこにも出ない', () => {
  const IDENTIFIER = 'id-9f3a';
  const APP_PASSWORD = 'pw-7c2e-secret';
  const BODY = 'BODY-MARKER';

  async function leakyRun(): Promise<{
    readonly postId: string;
    readonly records: LogRecord[];
  }> {
    const { records } = capture();
    usePublisher(async () => ({
      ok: false,
      reason: `auth failed for ${APP_PASSWORD}`,
      retryable: false,
    }));
    const accountId = await accountFor({
      credentials: { identifier: IDENTIFIER, appPassword: APP_PASSWORD },
    });
    const postId = await makePost(accountId, BODY);

    // **`runJob` を通す。** `job_runs.summary` / `error` まで見るため。
    await withConnection((connection) =>
      runJob(connection, SOCIAL_PUBLISH_JOB, {
        trigger: 'manual',
        wait: true,
        input: undefined,
      }),
    );

    return { postId, records };
  }

  it('#55 ログの全行に appPassword の値が出ない', async () => {
    const { records } = await leakyRun();

    expect(JSON.stringify(records)).not.toContain(APP_PASSWORD);
  });

  it('#55 ログの全行に identifier の値が出ない', async () => {
    const { records } = await leakyRun();

    expect(JSON.stringify(records)).not.toContain(IDENTIFIER);
  });

  it('#55 ログの全行に本文が出ない', async () => {
    // `log.*` の `fields` に `post.body` を入れない（設計 §6.5.5）。
    const { records } = await leakyRun();

    expect(JSON.stringify(records)).not.toContain(BODY);
  });

  it('#55 social_posts.failure_reason で資格情報が伏せられている', async () => {
    const { postId } = await leakyRun();

    expect((await postRow(postId)).failure_reason).toBe('auth failed for ***');
  });

  it('#55 job_runs の summary と error に資格情報が出ない', async () => {
    // `summary` は固定キーの数値だけ（設計 §6.5.7）。
    await leakyRun();

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('job_runs').select(['summary', 'error']).execute(),
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain(APP_PASSWORD);
    expect(text).not.toContain(IDENTIFIER);
    expect(text).not.toContain(BODY);
  });

  it('#55 audit_logs.detail に資格情報が出ない', async () => {
    await leakyRun();

    const rows = await withConnection(async (connection) =>
      connection.db.selectFrom('audit_logs').select(['detail']).execute(),
    );
    const text = JSON.stringify(rows);
    expect(text).not.toContain(APP_PASSWORD);
    expect(text).not.toContain(IDENTIFIER);
  });

  /**
   * #55。**Plugin へ渡す `logger` も伏せ字を通す**（設計 §6.5.5、検証レポート L-1）。
   *
   * もとは `maskSecrets`（キー名 `credential` / `token` / `secret` を落とす）しか
   * 通しておらず、Plugin が値を**文字列に埋める**と平文がそのまま出ていた。
   * `publishOne` はその行の資格情報の値を既に持っている。
   * **契約でなく機構で守れるものは機構で守る。**
   */
  async function loggingPublisherRun(): Promise<LogRecord[]> {
    const { records } = capture();
    usePublisher(async (input) => {
      input.logger.info('leak', { note: APP_PASSWORD });
      input.logger.warn(`${APP_PASSWORD} です`);
      return { ok: true };
    });
    const accountId = await accountFor({
      credentials: { identifier: IDENTIFIER, appPassword: APP_PASSWORD },
    });
    await makePost(accountId, BODY);

    await run();
    return records;
  }

  it('#55 Plugin が logger の fields に資格情報を入れても平文が出ない', async () => {
    const records = await loggingPublisherRun();

    expect(JSON.stringify(records)).not.toContain(APP_PASSWORD);
  });

  it('#55 Plugin が logger の message に資格情報を埋めても平文が出ない', async () => {
    const records = await loggingPublisherRun();
    const warned = records.find(
      (record) => record.level === 'warn' && record.message.endsWith(' です'),
    );

    expect(warned, 'Plugin の warn が記録されていない').toBeDefined();
    expect(warned?.message ?? '').not.toContain(APP_PASSWORD);
    expect(warned?.message ?? '').toContain('***');
  });

  it('#55 伏せたうえで Plugin のログ自体は残る（握りつぶさない）', async () => {
    // 伏せ字は「出さない」ためのもので、Plugin のログを消すためのものではない。
    const records = await loggingPublisherRun();

    expect(records.some((record) => JSON.stringify(record).includes('leak'))).toBe(true);
  });
});
