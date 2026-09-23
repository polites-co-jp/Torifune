import type { ManualHandoff, ManualInput, PublisherRegistration } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ForbiddenError,
  UnauthenticatedError,
  type AuthorizationContext,
} from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { resetEventHandlers } from '@/application/events';
import { registerPublisher, resetPublisherRegistry } from '@/application/social/publisher-registry';
import {
  createSocialAccount,
  createSocialPost,
  listManualPendingPosts,
  resolveManualHandoff,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { withConnection } from '@/application/transaction';
import type { UserIdentity } from '@/authentication/identity';
import { NotFoundError, ValidationError } from '@/domain/repository';
import type { SocialPost } from '@/domain/social/social';
import { resetLogger, setLogger, type LogRecord } from '@/infrastructure/logging';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 手動投稿の UseCase（035-social-publishing 設計 §6.6、受け入れ条件 #60・#61）。
 *
 * ```ts
 * listManualPendingPosts({ limit: number }) → { items, total }   // social.read
 * resolveManualHandoff({ id: string }) → ManualHandoffOutcome    // social.read
 *
 * type ManualHandoffOutcome =
 *   | { ok: true; url: string; note: string | null }
 *   | { ok: false; reason: 'unsupported' | 'invalid_url' | 'plugin_error' };
 * ```
 *
 * * 手動投稿待ちは**状態を増やさずに導出する**：`status = 'scheduled'` かつ
 *   `delivery_mode = 'manual'` かつ `scheduled_at <= now()`（設計 §5.8、裁定 #3）
 * * `resolveManualHandoff` は publisher の `manual()` を呼ぶだけで、
 *   **資格情報を渡さない**（設計 §6.5.5 末尾。Web Intent は公開 URL で足りる）
 * * 返った URL は「https の絶対 URL」か「`/` で始まり `//` / `/\` で始まらない
 *   同一オリジンのパス」に限る。それ以外は `invalid_url`（設計 §6.6）
 *
 * **2026-09-23 に判定を分けた（検証レポート L-2 / §6 の 6、#61 の書き直し）。**
 * 絶対 URL の判定にまで `isSafeReturnTo`（ログイン後の戻り先を決める関数）を
 * 流用しており、`isValidExternalUrl` より緩かった：`https://user:pass@evil/` が通り、
 * 長さの上限も無かった。**同じ「Plugin が返した URL」なのに `publish()` の
 * `externalUrl` より甘い門になっていた。** `isValidManualUrl`（設計 §5.6.1）へ分け、
 * 絶対 URL は `isValidExternalUrl` と同じ規則（userinfo を拒否・2048 文字以内）、
 * 相対パスの判定だけを `isSafeReturnTo` に委ねる。
 *
 * 偽の publisher は `registerPublisher('test-plugin', …)` で直接登録する
 * （Plugin の読み込みを経ない。設計 §10 冒頭）。
 */

const PLUGIN_ID = 'test-plugin';
/** publisher を登録する provider。 */
const PROVIDER = 'testsns';
/** publisher を登録しない provider。 */
const UNKNOWN_PROVIDER = 'nopublisher';

type ManualFn = NonNullable<PublisherRegistration['manual']>;

let scratch: ScratchDatabase;
let admin: AuthorizationContext;
let accountId: string;

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
        login_id: `mh${suffix}`,
        email: `mh${suffix}@example.com`,
        display_name: 'manual handoff test',
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
    loginId: `mh${suffix}`,
    displayName: 'manual handoff test',
    email: `mh${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

/** 未認証（`identity` が無い）の文脈。 */
async function anonymousContext(): Promise<AuthorizationContext> {
  return withConnection(async (connection) => ({
    identity: null,
    permissions: new Set<never>(),
    connection,
  }));
}

/** Permission を 1 つも持たない文脈。 */
function withoutPermissions(context: AuthorizationContext): AuthorizationContext {
  return { ...context, permissions: new Set<never>() };
}

/** 手動投稿に対応した偽の publisher を登録する。 */
function useManualPublisher(
  manual: ManualFn,
  overrides: Partial<PublisherRegistration> = {},
): ReturnType<typeof vi.fn<ManualFn>> {
  const mock = vi.fn<ManualFn>(manual);
  registerPublisher(PLUGIN_ID, {
    provider: PROVIDER,
    label: 'テストSNS',
    credentialFields: [{ key: 'identifier', label: '識別子', kind: 'text' }],
    manual: mock,
    ...overrides,
  });
  return mock;
}

async function accountFor(provider: string = PROVIDER): Promise<string> {
  const account = await createSocialAccount(admin, {
    provider,
    displayName: 'とりふね公式',
    handle: '@torifune',
    credential: null,
    status: 'connected',
  });
  return account.id;
}

interface PostOptions {
  readonly body?: string;
  readonly deliveryMode?: 'auto' | 'manual';
  readonly status?: 'draft' | 'scheduled' | 'published';
  readonly scheduledAt?: Date | null;
  readonly accountId?: string;
}

/** 既定は「手動投稿待ち」の投稿（manual / scheduled / 1 分前）。 */
async function makePost(options: PostOptions = {}): Promise<string> {
  const { post } = await createSocialPost(admin, {
    socialAccountId: options.accountId ?? accountId,
    body: options.body ?? '手動で投稿する本文',
    scheduledAt:
      options.scheduledAt === undefined ? new Date(Date.now() - 60_000) : options.scheduledAt,
    status: options.status ?? 'scheduled',
    deliveryMode: options.deliveryMode ?? 'manual',
  });
  return post.id;
}

/** 一覧の本文（`scheduled_at` の古い順に並ぶ）。 */
async function pendingBodies(limit = 50): Promise<readonly string[]> {
  const page = await listManualPendingPosts(admin, { limit });
  return page.items.map((post: SocialPost) => post.body);
}

/** `manual()` が受け取った引数を貯める publisher を登録する。 */
function recordManualCalls(): readonly ManualInput[] {
  const calls: ManualInput[] = [];
  useManualPublisher((input) => {
    calls.push(input);
    return { url: 'https://bsky.app/intent/compose' };
  });
  return calls;
}

beforeAll(async () => {
  scratch = await useScratchDatabase('manualhandoff');
});

afterAll(async () => {
  await scratch.dispose();
});

beforeEach(async () => {
  admin = await contextFor('administrator');
  accountId = await accountFor();
});

afterEach(async () => {
  resetPublisherRegistry();
  resetEventHandlers();
  resetLogger();
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_posts').execute();
    await connection.db.deleteFrom('social_accounts').execute();
    await connection.db.deleteFrom('audit_logs').execute();
    await connection.db.deleteFrom('users').execute();
  });
});

// ---------------------------------------------------------------------------
// #60 listManualPendingPosts
// ---------------------------------------------------------------------------

describe('#60 手動投稿待ちの一覧', () => {
  beforeEach(() => {
    useManualPublisher(() => ({ url: 'https://example.test/compose' }));
  });

  it('#60 manual / scheduled / 期限到来の投稿を返す', async () => {
    await makePost({ body: '期限の来た手動投稿' });

    expect(await pendingBodies()).toEqual(['期限の来た手動投稿']);
  });

  it('#60 scheduled_at の古い順に並ぶ', async () => {
    await makePost({ body: '新しいほう', scheduledAt: new Date(Date.now() - 60_000) });
    await makePost({ body: '古いほう', scheduledAt: new Date(Date.now() - 600_000) });

    expect(await pendingBodies()).toEqual(['古いほう', '新しいほう']);
  });

  it('#60 予約日時がまだ来ていない manual を含まない', async () => {
    // 「手動投稿待ち」は期限が来てから並ぶ（設計 §5.8）。
    await makePost({ body: '未来の手動投稿', scheduledAt: new Date(Date.now() + 600_000) });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 auto の投稿を含まない', async () => {
    // 自動配信はジョブが送る。人が押す列には並べない。
    await makePost({ body: '自動配信', deliveryMode: 'auto' });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 draft の投稿を含まない', async () => {
    await makePost({ body: '下書き', status: 'draft', scheduledAt: null });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 published の投稿を含まない', async () => {
    const id = await makePost({ body: '投稿済み' });
    await updateSocialPost(admin, { id, status: 'published' });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 scheduled_at が無い manual の投稿を含まない', async () => {
    // 期限の無い予約は「いつ人が動くか」が決まらない（設計 §6.6 の SQL）。
    const id = await makePost({ body: '期限なし' });
    await withConnection(async (connection) => {
      await connection.db
        .updateTable('social_posts')
        .set({ scheduled_at: null })
        .where('id', '=', id)
        .execute();
    });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 items は limit 件で打ち切る', async () => {
    for (let index = 0; index < 3; index += 1) {
      await makePost({
        body: `手動投稿 ${index}`,
        scheduledAt: new Date(Date.now() - (index + 1) * 60_000),
      });
    }

    const page = await listManualPendingPosts(admin, { limit: 2 });

    expect(page.items).toHaveLength(2);
  });

  it('#60 total は limit で切られる前の全件数', async () => {
    // ダッシュボードは `limit: 1` で件数だけを取る（設計 §7.6）。
    for (let index = 0; index < 3; index += 1) {
      await makePost({
        body: `手動投稿 ${index}`,
        scheduledAt: new Date(Date.now() - (index + 1) * 60_000),
      });
    }

    const page = await listManualPendingPosts(admin, { limit: 1 });

    expect(page.total).toBe(3);
  });

  it('#60 対象が無ければ items が空で total が 0', async () => {
    const page = await listManualPendingPosts(admin, { limit: 50 });

    expect(page).toMatchObject({ items: [], total: 0 });
  });

  /** #35 の寄せ直し（実装プラン §8「G3 からの申し送り」）。 */
  it('#60 取りやめて draft に戻した投稿は一覧から消える', async () => {
    const id = await makePost({ body: '取りやめる' });
    expect(await pendingBodies()).toEqual(['取りやめる']);

    await updateSocialPost(admin, { id, status: 'draft' });

    expect(await pendingBodies()).toEqual([]);
  });

  it('#60 social.read を持たない主体が呼ぶと ForbiddenError', async () => {
    await makePost();

    await expect(
      listManualPendingPosts(withoutPermissions(admin), { limit: 50 }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('#60 未認証で呼ぶと UnauthenticatedError', async () => {
    await makePost();
    const anonymous = await anonymousContext();

    await expect(listManualPendingPosts(anonymous, { limit: 50 })).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('#60 未認証は ForbiddenError ではない（401 と 403 を取り違えない）', async () => {
    const anonymous = await anonymousContext();

    await expect(listManualPendingPosts(anonymous, { limit: 50 })).rejects.not.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

// ---------------------------------------------------------------------------
// #61 resolveManualHandoff
// ---------------------------------------------------------------------------

describe('#61 投稿画面の URL を publisher に作らせる', () => {
  it('#61 manual() が返した url と note をそのまま返す', async () => {
    useManualPublisher(() => ({
      url: 'https://bsky.app/intent/compose?text=hello',
      note: '画像は投稿画面で添付してください',
    }));
    const id = await makePost();

    await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
      ok: true,
      url: 'https://bsky.app/intent/compose?text=hello',
      note: '画像は投稿画面で添付してください',
    });
  });

  it('#61 note を返さない publisher では note が null', async () => {
    useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose?text=hello' }));
    const id = await makePost();

    await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
      ok: true,
      url: 'https://bsky.app/intent/compose?text=hello',
      note: null,
    });
  });

  /**
   * #61（2026-09-23 に足した。4 回目の検証の低-3）。
   * **`note` も Plugin 由来の自由文なので秘匿を通る**（設計 §6.6）。
   *
   * `url` は `isValidManualUrl` が、`reason` 系は `redactSecrets` が見ているのに、
   * `note` だけが素通しで **`social.read` で読める面（手動投稿待ち一覧）へ出ていた**。
   */
  describe('#61 note の秘匿', () => {
    /** 接続文字列の形の生きた値。`redactSecrets` の (a) が credential 部を伏せる。 */
    const LIVE_VALUE = 'postgresql://plugin:s3cretpw@db.internal:5432/appdb';

    async function noteFor(note: string): Promise<string | null> {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose', note }));
      const id = await makePost();
      const outcome = await resolveManualHandoff(admin, { id });

      return outcome.ok ? outcome.note : null;
    }

    it('#61 note に混じった接続文字列が平文で出ない', async () => {
      const note = await noteFor(`投稿画面が開けないときは ${LIVE_VALUE} を確認してください`);

      expect(note, 'note が redactSecrets を通っていない').not.toContain('s3cretpw');
    });

    it('#61 伏せても note の残りの文は消えない', async () => {
      const note = await noteFor(`投稿画面が開けないときは ${LIVE_VALUE} を確認してください`);

      expect(note).toContain('投稿画面が開けないときは');
      expect(note).toContain('***');
    });

    it('#61 秘匿に掛からない note はそのまま返る', async () => {
      // 伏せ字は接続情報の形にだけ効く。普通の案内文を壊さない。
      expect(await noteFor('画像は投稿画面で添付してください')).toBe(
        '画像は投稿画面で添付してください',
      );
    });
  });

  it('#61 manual() が Promise を返してもよい', async () => {
    useManualPublisher(async () => Promise.resolve({ url: 'https://bsky.app/intent/compose' }));
    const id = await makePost();

    await expect(resolveManualHandoff(admin, { id })).resolves.toMatchObject({ ok: true });
  });

  /**
   * #61 の要。**資格情報は渡らない**（設計 §6.5.5 末尾）。
   *
   * 投稿画面の URL は公開の Web Intent で、資格情報を要しない。
   * 渡すと「配信のときだけ」という約束が崩れ、監査の外で平文が広がる。
   */
  it('#61 manual() の引数のキーが post と account だけ', async () => {
    const calls = recordManualCalls();
    const id = await makePost();

    await resolveManualHandoff(admin, { id });

    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(['account', 'post']);
  });

  it('#61 manual() の引数に credential が無い', async () => {
    const calls = recordManualCalls();
    const id = await makePost();

    await resolveManualHandoff(admin, { id });

    expect(
      (calls[0] as unknown as Record<string, unknown> | undefined)?.['credential'],
    ).toBeUndefined();
  });

  it('#61 manual() は対象の投稿とそのアカウントを受け取る', async () => {
    const calls = recordManualCalls();
    const id = await makePost({ body: '手渡す本文' });

    await resolveManualHandoff(admin, { id });

    expect(calls[0]).toMatchObject({
      post: { id, body: '手渡す本文', deliveryMode: 'manual' },
      account: { id: accountId, provider: PROVIDER },
    });
  });

  it('#61 account に資格情報の平文が乗らない（credentialConfigured だけ）', async () => {
    const calls = recordManualCalls();
    const id = await makePost();

    await resolveManualHandoff(admin, { id });

    expect(JSON.stringify(calls[0]?.account)).not.toMatch(/credential"\s*:\s*"/);
  });

  describe('URL の検査', () => {
    async function outcomeFor(url: string): Promise<unknown> {
      useManualPublisher(() => ({ url }) as ManualHandoff);
      const id = await makePost();
      return resolveManualHandoff(admin, { id });
    }

    it('#61 https の絶対 URL は ok', async () => {
      await expect(outcomeFor('https://x.com/intent/post?text=a')).resolves.toMatchObject({
        ok: true,
        url: 'https://x.com/intent/post?text=a',
      });
    });

    it('#61 / で始まる同一オリジンのパスは ok', async () => {
      // Plugin が自分の画面（`ui.registerPage`）へ渡す形。
      await expect(outcomeFor('/plugins/p/manual')).resolves.toMatchObject({
        ok: true,
        url: '/plugins/p/manual',
      });
    });

    it('#61 http の絶対 URL は invalid_url', async () => {
      await expect(outcomeFor('http://evil')).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });

    it('#61 // で始まるパスは invalid_url（プロトコル相対は別サイトへ飛ぶ）', async () => {
      await expect(outcomeFor('//evil')).resolves.toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('#61 /\\ で始まるパスは invalid_url（ブラウザが // と同じに扱う）', async () => {
      await expect(outcomeFor('/\\evil')).resolves.toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('#61 javascript: は invalid_url', async () => {
      await expect(outcomeFor('javascript:alert(1)')).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });

    it('#61 / で始まらない相対パスは invalid_url', async () => {
      await expect(outcomeFor('intent/compose')).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });

    it('#61 空文字は invalid_url', async () => {
      await expect(outcomeFor('')).resolves.toEqual({ ok: false, reason: 'invalid_url' });
    });

    /**
     * #61（2026-09-23 に足した。検証レポート L-2）。
     *
     * **`isValidExternalUrl` と同じ規則に揃える。** 資格情報付きの URL は、
     * 表示された見かけと実際の宛先が食い違う（`https://bsky.app@evil/` のような形）。
     * `publish()` が返す `externalUrl` は拒否しているのに、`manual()` の
     * 戻り値だけが通るのは門の不揃いである。
     */
    it('#61 資格情報付きの https は invalid_url', async () => {
      await expect(outcomeFor('https://user:pass@bsky.app/')).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });

    it('#61 利用者名だけの https も invalid_url', async () => {
      await expect(outcomeFor('https://user@bsky.app/')).resolves.toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });

    it('#61 2049 文字の https は invalid_url（長さの上限がある）', async () => {
      const url = `https://bsky.app/${'a'.repeat(2049 - 'https://bsky.app/'.length)}`;
      expect(url).toHaveLength(2049);

      await expect(outcomeFor(url)).resolves.toEqual({ ok: false, reason: 'invalid_url' });
    });

    it('#61 2048 文字ちょうどの https は ok（境界）', async () => {
      const url = `https://bsky.app/${'a'.repeat(2048 - 'https://bsky.app/'.length)}`;
      expect(url).toHaveLength(2048);

      await expect(outcomeFor(url)).resolves.toMatchObject({ ok: true, url });
    });
  });

  describe('publisher が応えられないとき', () => {
    it('#61 manual を実装していない publisher は unsupported', async () => {
      // 登録の後に Plugin が manual を落とした場合（投稿そのものは既にある）。
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();
      resetPublisherRegistry();
      registerPublisher(PLUGIN_ID, {
        provider: PROVIDER,
        label: 'テストSNS',
        credentialFields: [],
      });

      await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
        ok: false,
        reason: 'unsupported',
      });
    });

    it('#61 publisher が登録されていなければ unsupported', async () => {
      // Plugin を無効にした後の画面がこれ（設計 §7.1 の「この SNS の Plugin が無効です」）。
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();
      resetPublisherRegistry();

      await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
        ok: false,
        reason: 'unsupported',
      });
    });

    it('#61 別の provider の publisher しか無ければ unsupported', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();
      resetPublisherRegistry();
      registerPublisher(PLUGIN_ID, {
        provider: UNKNOWN_PROVIDER,
        label: 'ほかのSNS',
        credentialFields: [],
        manual: () => ({ url: 'https://other.test/compose' }),
      });

      await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
        ok: false,
        reason: 'unsupported',
      });
    });

    it('#61 manual() が例外を投げると plugin_error', async () => {
      useManualPublisher(() => {
        throw new Error('intent build failed at line 42');
      });
      const id = await makePost();

      await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
        ok: false,
        reason: 'plugin_error',
      });
    });

    it('#61 例外の内容を戻り値に出さない', async () => {
      useManualPublisher(() => {
        throw new Error('intent build failed at line 42');
      });
      const id = await makePost();

      const outcome = await resolveManualHandoff(admin, { id });

      expect(JSON.stringify(outcome)).not.toContain('intent build failed');
    });

    it('#61 例外はログに残る', async () => {
      // 画面には出さないが、運用者が原因へ辿れる経路は残す（設計 §6.6）。
      useManualPublisher(() => {
        throw new Error('intent build failed at line 42');
      });
      const id = await makePost();
      const logs = capture();

      await resolveManualHandoff(admin, { id });

      expect(logs.records.some((record) => record.level === 'error')).toBe(true);
    });

    it('#61 Promise が reject しても plugin_error', async () => {
      useManualPublisher(async () => Promise.reject(new Error('boom')));
      const id = await makePost();

      await expect(resolveManualHandoff(admin, { id })).resolves.toEqual({
        ok: false,
        reason: 'plugin_error',
      });
    });
  });

  describe('対象にならない投稿', () => {
    it('#61 auto の投稿は ValidationError', async () => {
      // 自動配信の投稿に「投稿画面を開く」は無い（設計 §6.6）。
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost({ deliveryMode: 'auto' });

      await expect(resolveManualHandoff(admin, { id })).rejects.toBeInstanceOf(ValidationError);
    });

    it('#61 auto の投稿の例外のフィールドは deliveryMode', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost({ deliveryMode: 'auto' });

      const error = await resolveManualHandoff(admin, { id }).catch((caught: unknown) => caught);

      expect((error as ValidationError).field).toBe('deliveryMode');
    });

    it('#61 存在しない投稿は NotFoundError', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));

      await expect(resolveManualHandoff(admin, { id: uuidv7() })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('権限', () => {
    it('#61 social.read を持たない主体が呼ぶと ForbiddenError', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();

      await expect(resolveManualHandoff(withoutPermissions(admin), { id })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('#61 権限が無ければ manual() は呼ばれない', async () => {
      // 認可は UseCase の入口。publisher へ渡る前に止める。
      const manual = useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();

      await resolveManualHandoff(withoutPermissions(admin), { id }).catch(() => undefined);

      expect(manual).not.toHaveBeenCalled();
    });

    it('#61 未認証で呼ぶと UnauthenticatedError', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();
      const anonymous = await anonymousContext();

      await expect(resolveManualHandoff(anonymous, { id })).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    });

    it('#61 未認証は ForbiddenError ではない（401 と 403 を取り違えない）', async () => {
      useManualPublisher(() => ({ url: 'https://bsky.app/intent/compose' }));
      const id = await makePost();
      const anonymous = await anonymousContext();

      await expect(resolveManualHandoff(anonymous, { id })).rejects.not.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
