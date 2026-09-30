import type { PublisherRegistration } from '@torifune/plugin-api';
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
import { decryptSecret } from '@/infrastructure/crypto/cipher';
import { setEncryptionKey } from '@/infrastructure/crypto/key';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 配信ジョブの `rotatedCredential` の書き戻しを比較更新にする
 * （039-social-credential-fields 設計 §6.1、受け入れ条件 #55〜#62。`035` §11 #25 の修正）。
 *
 * **書き戻しは「配信の前に読んだ暗号文」と DB の暗号文が同じときだけ行う。**
 * 配信が飛んでいる間に運用者が資格情報を差し替えた・消した（同じ値の入れ直しを含む）なら、
 * Plugin が返した値は捨てる。運用者の値が正である。
 *
 * * 「配信中に運用者が操作する」は、偽の publisher の `publish()` の中で UseCase `updateSocialAccount`
 *   （`PATCH` と同じ経路）を **`await` してから** 結果を返すことで作る（設計 §10.10 の前書き）。
 *   `publish()` が返る前に運用者の更新が確定しているので、待ち合わせや時間に頼らず決定的に重なる
 * * 書き戻しをどう終えても（書いた・捨てた・失敗した）、**投稿は `published` と記録される**
 * * ログ・監査・`job_runs.summary` に載るのは `accountId` / `pluginId`（と SQLSTATE）だけ。
 *   値・暗号文（＝版）は載せない
 *
 * 手本は `publish-credential.integration.test.ts`（`035` #53）。import せずに形を写す（実装プラン §2）。
 */

const PLUGIN_ID = 'test-rotation-plugin';
const PROVIDER = 'testsns';
const CREDENTIAL_FIELDS = [
  { key: 'identifier', label: '識別子', kind: 'text' },
  { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
] as const;

/** 配信の前に保存されている資格情報。 */
const INITIAL = { identifier: 'init-id-4d1e', appPassword: 'init-pw-8b2f' } as const;
/** Plugin が返す更新後の資格情報 R。 */
const ROTATED = { identifier: 'rot-id-R7c3', appPassword: 'rot-pw-R9a1' } as const;
/** 配信中に運用者が入れる別の資格情報 O。 */
const OPERATOR = { identifier: 'op-id-O2e5', appPassword: 'op-pw-O6f0' } as const;

const DISCARDED_CHANGED =
  'rotated credential was discarded because the account credential changed during publish';
const IGNORED_EMPTY_FIELDS = 'rotated credential ignored for publisher without credential fields';
const COULD_NOT_BE_SAVED = 'rotated credential could not be saved';

type PublishFn = NonNullable<PublisherRegistration['publish']>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

interface Actor {
  readonly context: AuthorizationContext;
  readonly userId: string;
}

function capture(): { records: LogRecord[] } {
  const records: LogRecord[] = [];
  setLogger({
    log(level, message, fields) {
      records.push({ level, message, ...(fields === undefined ? {} : { fields }) });
    },
  });
  return { records };
}

async function actorFor(roleName: string): Promise<Actor> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `rot${suffix}`,
        email: `rot${suffix}@example.com`,
        display_name: 'publish rotation test',
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
    loginId: `rot${suffix}`,
    displayName: 'publish rotation test',
    email: `rot${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  const context = await withConnection(async (connection) =>
    authorizationContextFor(connection, identity),
  );
  return { context, userId: id };
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

async function makePost(accountId: string): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: accountId,
    body: '配信される本文',
    scheduledAt: new Date(Date.now() - 60_000),
    status: 'scheduled',
    deliveryMode: 'auto',
  });
  return post.id;
}

async function postStatus(id: string): Promise<string> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_posts')
      .select(['status'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`投稿が無い: ${id}`);
  return row.status;
}

interface AccountRowSnapshot {
  readonly credential: string | null;
  readonly updatedAt: Date;
}

async function accountRow(accountId: string): Promise<AccountRowSnapshot> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential', 'updated_at'])
      .where('id', '=', accountId)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`アカウントが無い: ${accountId}`);
  return { credential: row.credential, updatedAt: new Date(row.updated_at as unknown as Date) };
}

async function storedCredential(accountId: string): Promise<string | null> {
  return (await accountRow(accountId)).credential;
}

/** DB の暗号文を復号して JSON として読む。保存されていなければ null。 */
async function decryptedCredential(accountId: string): Promise<unknown> {
  const stored = await storedCredential(accountId);
  if (stored === null) return null;
  const decrypted = decryptSecret(stored);
  if (!decrypted.ok) throw new Error('保存されている資格情報を復号できない');
  return JSON.parse(decrypted.secret.expose()) as unknown;
}

interface AuditRow {
  readonly action: string;
  readonly resource_type: string;
  readonly resource_id: string | null;
  readonly actor_user_id: string | null;
  readonly detail: Record<string, unknown>;
}

async function auditRows(): Promise<AuditRow[]> {
  return withConnection(async (connection) => {
    const rows = await connection.db
      .selectFrom('audit_logs')
      .select(['action', 'resource_type', 'resource_id', 'actor_user_id', 'detail'])
      .execute();
    return rows as AuditRow[];
  });
}

/** 書き戻しの監査（`updated` で `detail.rotated === true`）。 */
async function rotatedAuditRows(): Promise<AuditRow[]> {
  return (await auditRows()).filter(
    (row) =>
      row.action === 'updated' &&
      row.resource_type === 'social_account' &&
      row.detail['rotated'] === true,
  );
}

function recordsWith(records: readonly LogRecord[], level: string, message: string): LogRecord[] {
  return records.filter((record) => record.level === level && record.message === message);
}

async function run() {
  return withConnection((connection) => publishDuePosts(connection));
}

// ---------------------------------------------------------------------------
// 場面：配信中の運用者の操作
// ---------------------------------------------------------------------------

/** 配信中（`publish()` の中）に運用者が行う操作。`null` は何もしない（対照）。 */
type OperatorAction = ((operator: Actor, accountId: string) => Promise<void>) | null;

const ACTIONS = {
  /** #55 対照：競合しない。 */
  none: null,
  /** #56 消す（画面の「資格情報を消す」と同じ本文）。 */
  clear: async (operator, accountId) => {
    await updateSocialAccount(operator.context, {
      id: accountId,
      credentials: {},
      status: 'disconnected',
    });
  },
  /** #57 別の 2 項目 O に差し替える。 */
  replace: async (operator, accountId) => {
    await updateSocialAccount(operator.context, { id: accountId, credentials: OPERATOR });
  },
  /** #58 配信の前と同じ平文で入れ直す（暗号文は IV で変わる）。 */
  reenterSame: async (operator, accountId) => {
    await updateSocialAccount(operator.context, { id: accountId, credentials: INITIAL });
  },
  /** #59 資格情報以外（表示名）だけを変える。`updated_at` は動く。 */
  renameOnly: async (operator, accountId) => {
    await updateSocialAccount(operator.context, {
      id: accountId,
      displayName: '表示名だけ変えた',
    });
  },
} satisfies Record<string, OperatorAction>;

type ActionName = keyof typeof ACTIONS;

interface Scenario {
  readonly accountId: string;
  readonly postId: string;
  readonly operator: Actor;
  readonly publish: ReturnType<typeof vi.fn<PublishFn>>;
  readonly records: LogRecord[];
  /** 配信の前の行。 */
  readonly before: AccountRowSnapshot;
  /** 運用者の操作の直後（`publish()` が返る前）の行。 */
  readonly during: AccountRowSnapshot;
  /** 配信ジョブの後の行。 */
  readonly after: AccountRowSnapshot;
  /** `publishDuePosts` の戻り値。`runJob` を通したときは null。 */
  readonly summary: Awaited<ReturnType<typeof run>> | null;
}

/**
 * `INITIAL` を保存したアカウントに期限の来た `auto` の投稿を 1 件置き、配信ジョブを 1 回走らせる。
 * publisher は `publish()` の中で `action` を済ませてから `{ ok: true, rotatedCredential: ROTATED }` を返す。
 */
async function scenario(
  actionName: ActionName,
  options: { readonly viaJob?: boolean } = {},
): Promise<Scenario> {
  const action: OperatorAction = ACTIONS[actionName];
  const { records } = capture();
  const operator = await actorFor('administrator');

  let accountId = '';
  let during: AccountRowSnapshot | null = null;
  const publish = usePublisher(async () => {
    if (action !== null) {
      await action(operator, accountId);
    }
    during = await accountRow(accountId);
    return { ok: true, rotatedCredential: { ...ROTATED } };
  });

  accountId = await accountFor({ credentials: INITIAL });
  const postId = await makePost(accountId);
  const before = await accountRow(accountId);

  let summary: Awaited<ReturnType<typeof run>> | null = null;
  if (options.viaJob === true) {
    // **`runJob` を通す。** `job_runs.summary` まで見るため（実装プラン §8 の 27）。
    await withConnection((connection) =>
      runJob(connection, SOCIAL_PUBLISH_JOB, { trigger: 'manual', wait: true, input: undefined }),
    );
  } else {
    summary = await run();
  }

  const after = await accountRow(accountId);
  if (during === null) throw new Error('publish() が呼ばれていない');

  return { accountId, postId, operator, publish, records, before, during, after, summary };
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialpublishrotation');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = (await actorFor('administrator')).context;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  setEncryptionKey(null);
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('job_runs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #55 対照
// ---------------------------------------------------------------------------

/** #55。**競合しなければ従来どおり書き戻される**（比較更新にしても通常時の挙動を変えない）。 */
describe('#55 対照：配信中に誰も触らなければ書き戻される', () => {
  it('#55 投稿は published', async () => {
    const { postId } = await scenario('none');

    expect(await postStatus(postId)).toBe('published');
  });

  it('#55 DB を復号すると R ちょうど', async () => {
    const { accountId } = await scenario('none');

    expect(await decryptedCredential(accountId)).toEqual(ROTATED);
  });

  it('#55 rotated: true の監査が 1 行で、detail が { changed: [credential], rotated: true, pluginId }', async () => {
    const { accountId } = await scenario('none');
    const rows = await rotatedAuditRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.resource_id).toBe(accountId);
    expect(rows[0]?.detail).toEqual({
      changed: ['credential'],
      rotated: true,
      pluginId: PLUGIN_ID,
    });
  });

  it('#55 書き戻しを捨てた旨の warn は出ない', async () => {
    const { records } = await scenario('none');

    expect(recordsWith(records, 'warn', DISCARDED_CHANGED)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #56 配信中に消す
// ---------------------------------------------------------------------------

describe('#56 配信中に運用者が資格情報を消す', () => {
  it('#56 投稿は published', async () => {
    const { postId } = await scenario('clear');

    expect(await postStatus(postId)).toBe('published');
  });

  it('#56 アカウントの credential は NULL のまま（credentialConfigured: false）', async () => {
    const { accountId } = await scenario('clear');

    expect(await storedCredential(accountId)).toBeNull();
    const account = await withConnection((connection) =>
      socialRepository.findAccountById(connection, accountId),
    );
    expect(account?.credentialConfigured).toBe(false);
  });

  it('#56 rotated: true の監査の行が無い', async () => {
    await scenario('clear');

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it('#56 運用者の updated（actor_user_id が運用者）の行はある', async () => {
    const { accountId, operator } = await scenario('clear');
    const rows = (await auditRows()).filter(
      (row) =>
        row.action === 'updated' &&
        row.resource_type === 'social_account' &&
        row.resource_id === accountId &&
        row.actor_user_id === operator.userId,
    );

    expect(rows).toHaveLength(1);
  });

  it('#56 捨てた旨の log.warn が 1 回', async () => {
    const { records } = await scenario('clear');

    expect(recordsWith(records, 'warn', DISCARDED_CHANGED)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #57 配信中に差し替える
// ---------------------------------------------------------------------------

describe('#57 配信中に運用者が別の値 O に差し替える', () => {
  it('#57 投稿は published', async () => {
    const { postId } = await scenario('replace');

    expect(await postStatus(postId)).toBe('published');
  });

  it('#57 DB を復号すると O ちょうど（R ではない）', async () => {
    const { accountId } = await scenario('replace');

    expect(await decryptedCredential(accountId)).toEqual(OPERATOR);
  });

  it('#57 DB の暗号文は運用者が保存したものから変わらない', async () => {
    const { during, after } = await scenario('replace');

    expect(after.credential).toBe(during.credential);
  });

  it('#57 rotated: true の監査の行が無い', async () => {
    await scenario('replace');

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it('#57 捨てた旨の log.warn が 1 回', async () => {
    const { records } = await scenario('replace');

    expect(recordsWith(records, 'warn', DISCARDED_CHANGED)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #58 配信中に同じ値を入れ直す
// ---------------------------------------------------------------------------

/**
 * #58。**同じ平文でも暗号文は変わる**（IV を毎回変える）ので、運用者が触ったことが分かる。
 * 運用者の操作を優先し、書き戻しは捨てる（設計 §6.1 の 1）。
 */
describe('#58 配信中に運用者が配信の前と同じ値を入れ直す', () => {
  it('#58 前提：入れ直しで暗号文が変わっている', async () => {
    const { before, during } = await scenario('reenterSame');

    expect(during.credential).not.toBeNull();
    expect(during.credential).not.toBe(before.credential);
  });

  it('#58 書き戻しは捨てられ、DB を復号すると運用者が入れた値', async () => {
    const { accountId } = await scenario('reenterSame');

    expect(await decryptedCredential(accountId)).toEqual(INITIAL);
  });

  it('#58 DB の暗号文は運用者が保存したものから変わらない', async () => {
    const { during, after } = await scenario('reenterSame');

    expect(after.credential).toBe(during.credential);
  });

  it('#58 rotated: true の監査の行が無い', async () => {
    await scenario('reenterSame');

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it('#58 投稿は published', async () => {
    const { postId } = await scenario('reenterSame');

    expect(await postStatus(postId)).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// #59 配信中に資格情報以外だけを変える
// ---------------------------------------------------------------------------

/** #59。**版に `updated_at` を使わない**ことの固定（設計 §6.1 の 1）。 */
describe('#59 配信中に運用者が表示名だけを変える', () => {
  it('#59 前提：表示名の変更で updated_at が動き、暗号文は変わらない', async () => {
    const { before, during } = await scenario('renameOnly');

    expect(during.updatedAt.getTime()).not.toBe(before.updatedAt.getTime());
    expect(during.credential).toBe(before.credential);
  });

  it('#59 書き戻され、DB を復号すると R', async () => {
    const { accountId } = await scenario('renameOnly');

    expect(await decryptedCredential(accountId)).toEqual(ROTATED);
  });

  it('#59 rotated: true の監査が 1 行', async () => {
    await scenario('renameOnly');

    expect(await rotatedAuditRows()).toHaveLength(1);
  });

  it('#59 投稿は published', async () => {
    const { postId } = await scenario('renameOnly');

    expect(await postStatus(postId)).toBe('published');
  });
});

// ---------------------------------------------------------------------------
// #60 値・暗号文を外へ出さない
// ---------------------------------------------------------------------------

/**
 * #60。#55〜#59 のすべてで、ログ（`message` と `fields`）・`job_runs.summary`・`audit_logs.detail` に
 * R / O の値も、配信の前後のどの暗号文も現れない。
 *
 * `runJob` を通す（`job_runs.summary` は `publishDuePosts` を直接呼ぶと作られない。実装プラン §8 の 27）。
 */
describe('#60 書き戻しの値・暗号文がログ・summary・監査に出ない', () => {
  const CASES: readonly [string, ActionName][] = [
    ['#55 対照', 'none'],
    ['#56 配信中に消す', 'clear'],
    ['#57 配信中に差し替える', 'replace'],
    ['#58 配信中に同じ値を入れ直す', 'reenterSame'],
    ['#59 配信中に表示名だけ変える', 'renameOnly'],
  ];

  /** 探す文字列：R / O の各値と、配信の前・運用者の操作の後・配信の後の暗号文。 */
  function needlesOf(result: Scenario): string[] {
    return [
      ...Object.values(ROTATED),
      ...Object.values(OPERATOR),
      ...[result.before.credential, result.during.credential, result.after.credential].filter(
        (value): value is string => value !== null,
      ),
    ];
  }

  function logText(records: readonly LogRecord[]): string {
    return records
      .map((record) => `${record.message} ${JSON.stringify(record.fields ?? {})}`)
      .join('\n');
  }

  it.each(CASES)(
    '#60 %s：配信ジョブが走り、投稿が published になっている（前提）',
    async (_, name) => {
      const result = await scenario(name, { viaJob: true });

      expect(result.publish).toHaveBeenCalledTimes(1);
      expect(await postStatus(result.postId)).toBe('published');
      const runs = await withConnection((connection) =>
        connection.db.selectFrom('job_runs').select(['summary']).execute(),
      );
      expect(runs).toHaveLength(1);
    },
  );

  it.each(CASES)('#60 %s：ログに値も暗号文も現れない', async (_, name) => {
    const result = await scenario(name, { viaJob: true });
    const text = logText(result.records);

    for (const needle of needlesOf(result)) {
      expect(text, 'ログに値か暗号文が現れた').not.toContain(needle);
    }
  });

  it.each(CASES)('#60 %s：job_runs.summary に値も暗号文も現れない', async (_, name) => {
    const result = await scenario(name, { viaJob: true });
    const text = JSON.stringify(
      await withConnection((connection) =>
        connection.db.selectFrom('job_runs').select(['summary']).execute(),
      ),
    );

    for (const needle of needlesOf(result)) {
      expect(text, 'job_runs.summary に値か暗号文が現れた').not.toContain(needle);
    }
  });

  it.each(CASES)('#60 %s：audit_logs.detail に値も暗号文も現れない', async (_, name) => {
    const result = await scenario(name, { viaJob: true });
    const text = JSON.stringify((await auditRows()).map((row) => row.detail));

    for (const needle of needlesOf(result)) {
      expect(text, 'audit_logs.detail に値か暗号文が現れた').not.toContain(needle);
    }
  });

  const DISCARDING_CASES = CASES.filter(([, name]) =>
    (['clear', 'replace', 'reenterSame'] as ActionName[]).includes(name),
  );

  it.each(DISCARDING_CASES)(
    '#60 %s：書き戻しの警告の fields のキーは accountId / pluginId ちょうど',
    async (_, name) => {
      const result = await scenario(name, { viaJob: true });
      const warned = recordsWith(result.records, 'warn', DISCARDED_CHANGED);

      expect(warned).toHaveLength(1);
      expect(Object.keys(warned[0]?.fields ?? {}).sort()).toEqual(['accountId', 'pluginId']);
      expect(warned[0]?.fields).toEqual({ accountId: result.accountId, pluginId: PLUGIN_ID });
    },
  );
});

// ---------------------------------------------------------------------------
// #61 書き戻しが例外を投げても投稿の記録を止めない
// ---------------------------------------------------------------------------

/**
 * #61。書き戻しの例外が `publishOne` の外へ出ると、その行は `unrecorded` になり、
 * 着手印が残って次の実行で「中断」として `failed` になる。**実際には投稿されたのに `failed` と記録され、
 * 出し直すと二重投稿になる**（設計 §6.1 の 4）。書き戻しは投稿の結果の付け足しであって、失敗しても記録を止めない。
 */
describe('#61 replaceCredentialIfUnchanged が例外を投げる', () => {
  /** DB のエラーの文言は SQL の値を含みうる（設計 §6.1 の 4 の表）。ログに載ってはならない。 */
  const ERROR_TEXT = 'db exploded near value rot-pw-R9a1 in UPDATE social_accounts';

  async function failingRun(error: Error = new Error(ERROR_TEXT)) {
    const { records } = capture();
    const spy = vi.spyOn(socialRepository, 'replaceCredentialIfUnchanged').mockRejectedValue(error);
    usePublisher(async () => ({ ok: true, rotatedCredential: { ...ROTATED } }));
    const accountId = await accountFor({ credentials: INITIAL });
    const postId = await makePost(accountId);
    const before = await accountRow(accountId);

    const summary = await run();
    return { accountId, postId, records, spy, summary, before };
  }

  it('#61 summary.published が 1 で unrecorded が 0', async () => {
    const { summary } = await failingRun();

    expect(summary.published).toBe(1);
    expect(summary.unrecorded).toBe(0);
  });

  it('#61 投稿は published と記録される', async () => {
    const { postId } = await failingRun();

    expect(await postStatus(postId)).toBe('published');
  });

  it("#61 log.error('rotated credential could not be saved') が 1 回", async () => {
    const { records } = await failingRun();

    expect(recordsWith(records, 'error', COULD_NOT_BE_SAVED)).toHaveLength(1);
  });

  it('#61 その log.error の fields に例外の文言が無い', async () => {
    const { records } = await failingRun();
    const [logged] = recordsWith(records, 'error', COULD_NOT_BE_SAVED);

    expect(logged).toBeDefined();
    expect(JSON.stringify(logged?.fields ?? {})).not.toContain('db exploded');
    expect(JSON.stringify(logged?.fields ?? {})).not.toContain(ROTATED.appPassword);
  });

  it('#61 SQLSTATE を持たない例外では fields が accountId / pluginId ちょうど（実装プラン §8 の 26）', async () => {
    const { accountId, records } = await failingRun();
    const [logged] = recordsWith(records, 'error', COULD_NOT_BE_SAVED);

    expect(logged?.fields).toEqual({ accountId, pluginId: PLUGIN_ID });
  });

  it('#61 SQLSTATE（5 文字の英大文字・数字の code）を持つ例外では code だけを足す（実装プラン §8 の 26）', async () => {
    const { accountId, records } = await failingRun(
      Object.assign(new Error(ERROR_TEXT), { code: '40P01' }),
    );
    const [logged] = recordsWith(records, 'error', COULD_NOT_BE_SAVED);

    expect(logged?.fields).toEqual({ accountId, pluginId: PLUGIN_ID, code: '40P01' });
  });

  it('#61 SQLSTATE の形でない code は載せない（実装プラン §8 の 26）', async () => {
    const { accountId, records } = await failingRun(
      Object.assign(new Error(ERROR_TEXT), { code: 'ECONNRESET' }),
    );
    const [logged] = recordsWith(records, 'error', COULD_NOT_BE_SAVED);

    expect(logged?.fields).toEqual({ accountId, pluginId: PLUGIN_ID });
  });

  it('#61 rotated: true の監査の行が無い', async () => {
    await failingRun();

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it('#61 アカウントの資格情報は配信の前のまま', async () => {
    const { accountId, before } = await failingRun();

    expect(await storedCredential(accountId)).toBe(before.credential);
  });

  it('#61 続けてもう一度走らせても、その投稿は「中断」として failed にならない', async () => {
    const { postId, spy } = await failingRun();
    spy.mockRestore();

    const second = await run();

    expect(second.interrupted).toBe(0);
    expect(await postStatus(postId)).toBe('published');
  });

  /**
   * 実装プラン §8 の 28。**暗号化（`encryptSecret`）で投げても同じ**（鍵が無いなど）。
   * 設計の原則「例外を `rotateCredential` の中で受け止める」の範囲。
   * 鍵は `publish()` の中で外す（資格情報の復号は済んでいる）。
   */
  async function keylessRun() {
    const { records } = capture();
    usePublisher(async () => {
      vi.stubEnv('TORIFUNE_ENCRYPTION_KEY', '');
      setEncryptionKey(null);
      return { ok: true, rotatedCredential: { ...ROTATED } };
    });
    const accountId = await accountFor({ credentials: INITIAL });
    const postId = await makePost(accountId);

    const summary = await run();
    vi.unstubAllEnvs();
    setEncryptionKey(null);
    return { accountId, postId, records, summary };
  }

  it('#61 暗号化で投げても（鍵が無い）投稿は published と記録され、unrecorded にならない', async () => {
    const { postId, summary } = await keylessRun();

    expect(summary.published).toBe(1);
    expect(summary.unrecorded).toBe(0);
    expect(await postStatus(postId)).toBe('published');
  });

  it("#61 暗号化で投げても log.error('rotated credential could not be saved') が 1 回", async () => {
    const { records } = await keylessRun();

    expect(recordsWith(records, 'error', COULD_NOT_BE_SAVED)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #62 credentialFields が空の publisher
// ---------------------------------------------------------------------------

/**
 * #62。`[]` は「資格情報を使わない」宣言（設計 §7.1）。読まない値を保存すると、問題 1 と同じ食い違いを作る。
 * 比べる版も読んでいない。**返された `rotatedCredential` は捨てる。**
 */
describe('#62 credentialFields: [] の publisher が rotatedCredential を返す', () => {
  const EMPTY_ROTATED = { token: 'rot-empty-token-5c9d' } as const;

  async function emptyFieldsRun(credential: string | null) {
    const { records } = capture();
    usePublisher(async () => ({ ok: true, rotatedCredential: { ...EMPTY_ROTATED } }), {
      credentialFields: [],
    });
    const accountId = await accountFor({ credential });
    const postId = await makePost(accountId);
    const before = await accountRow(accountId);

    await run();
    return { accountId, postId, records, before };
  }

  it('#62 投稿は published', async () => {
    const { postId } = await emptyFieldsRun(null);

    expect(await postStatus(postId)).toBe('published');
  });

  it('#62 資格情報が NULL のアカウントは NULL のまま', async () => {
    const { accountId } = await emptyFieldsRun(null);

    expect(await storedCredential(accountId)).toBeNull();
  });

  it('#62 資格情報が保存されているアカウントは配信の前の暗号文のまま', async () => {
    const { accountId, before } = await emptyFieldsRun('kept-free-text-3a7b');

    expect(before.credential).not.toBeNull();
    expect(await storedCredential(accountId)).toBe(before.credential);
  });

  it('#62 rotated: true の監査の行が無い', async () => {
    await emptyFieldsRun('kept-free-text-3a7b');

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it("#62 'rotated credential ignored for publisher without credential fields' の log.warn が 1 回", async () => {
    const { records } = await emptyFieldsRun(null);

    expect(recordsWith(records, 'warn', IGNORED_EMPTY_FIELDS)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// #75 型に反する rotatedCredential でも投稿の記録を止めない
// ---------------------------------------------------------------------------

/**
 * #75（設計 §6.1 の 4 の 2026-09-24 追記、§10.12）。Plugin は JavaScript なので、型の上では
 * `Record<string, string>` の `rotatedCredential` が、実際には型に反する値を持ちうる。
 * 宣言との突き合わせや `JSON.stringify` がそれで投げても、例外を `rotateCredential` の中で受け止める。
 * 外へ出ると `unrecorded` → 次の実行で「中断」の `failed` → 出し直して二重投稿になる。
 */
describe('#75 publisher が型に反する rotatedCredential を返す', () => {
  /** 例外の文言。ログに載ってはならない。 */
  const GETTER_TEXT = 'getter exploded near rot-pw-R9a1';

  const MALFORMED: readonly [string, () => Record<string, string>][] = [
    [
      '(a) 値の 1 つが BigInt（突き合わせは通り、JSON.stringify が投げる）',
      () =>
        ({ identifier: ROTATED.identifier, appPassword: 1n }) as unknown as Record<string, string>,
    ],
    [
      '(b) 宣言のキーの 1 つが読むと投げる getter（突き合わせが投げる）',
      () => {
        const value: Record<string, string> = { identifier: ROTATED.identifier };
        Object.defineProperty(value, 'appPassword', {
          enumerable: true,
          get() {
            throw new Error(GETTER_TEXT);
          },
        });
        return value;
      },
    ],
  ];

  async function malformedRun(make: () => Record<string, string>) {
    const { records } = capture();
    usePublisher(async () => ({ ok: true, rotatedCredential: make() }));
    const accountId = await accountFor({ credentials: INITIAL });
    const postId = await makePost(accountId);
    const before = await accountRow(accountId);

    const summary = await run();
    return { accountId, postId, records, summary, before };
  }

  it.each(MALFORMED)('#75 %s：summary.published が 1 で unrecorded が 0', async (_, make) => {
    const { summary } = await malformedRun(make);

    expect(summary.published).toBe(1);
    expect(summary.unrecorded).toBe(0);
  });

  it.each(MALFORMED)('#75 %s：投稿は published と記録される', async (_, make) => {
    const { postId } = await malformedRun(make);

    expect(await postStatus(postId)).toBe('published');
  });

  it.each(MALFORMED)('#75 %s：アカウントの資格情報は配信の前のまま', async (_, make) => {
    const { accountId, before } = await malformedRun(make);

    expect(await storedCredential(accountId)).toBe(before.credential);
  });

  it.each(MALFORMED)('#75 %s：rotated: true の監査の行が無い', async (_, make) => {
    await malformedRun(make);

    expect(await rotatedAuditRows()).toHaveLength(0);
  });

  it.each(MALFORMED)(
    "#75 %s：log.error('rotated credential could not be saved') が 1 回で、fields は accountId / pluginId ちょうど",
    async (_, make) => {
      const { accountId, records } = await malformedRun(make);
      const logged = recordsWith(records, 'error', COULD_NOT_BE_SAVED);

      expect(logged).toHaveLength(1);
      expect(logged[0]?.fields).toEqual({ accountId, pluginId: PLUGIN_ID });
    },
  );

  it.each(MALFORMED)('#75 %s：どのログにも例外の文言が無い', async (_, make) => {
    const { records } = await malformedRun(make);
    const text = records
      .map((record) => `${record.message} ${JSON.stringify(record.fields ?? {})}`)
      .join('\n');

    expect(text).not.toContain('getter exploded');
    expect(text).not.toContain('BigInt');
  });

  it.each(MALFORMED)(
    '#75 %s：続けてもう一度走らせても interrupted が 0 で、投稿は published のまま',
    async (_, make) => {
      const { postId } = await malformedRun(make);

      const second = await run();

      expect(second.interrupted).toBe(0);
      expect(await postStatus(postId)).toBe('published');
    },
  );
});
