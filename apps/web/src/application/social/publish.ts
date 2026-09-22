import type {
  PluginLogger,
  PublishInput,
  PublishResult,
  PublisherRegistration,
  SocialAccountView,
  SocialPostView,
} from '@torifune/plugin-api';
import { recordSystemAudit } from '@/application/audit';
import { emit } from '@/application/events';
import { findPublisher, type RegisteredPublisher } from '@/application/social/publisher-registry';
import { normalizeFailureReason } from '@/application/social/social-use-cases';
import type { Connection } from '@/database/provider';
import {
  CREDENTIAL_MAX_LENGTH,
  parseCredentialObject,
  validateCredentialAgainstFields,
  type CredentialField,
} from '@/domain/social/credential';
import {
  credentialMismatchReason,
  CREDENTIAL_MISSING_REASON,
  CREDENTIAL_UNREADABLE_REASON,
  decidePublishOutcome,
  INTERRUPTED_REASON,
  PUBLISH_BATCH_SIZE,
  PUBLISH_TIMEOUT_MS,
  redactCredentialValues,
  type PublishAttemptResult,
  type PublishVerdict,
} from '@/domain/social/publishing';
import type { SocialAccount, SocialPost } from '@/domain/social/social';
import { encryptSecret } from '@/infrastructure/crypto/cipher';
import { log } from '@/infrastructure/logging';
import { redactSecrets } from '@/infrastructure/secret-text';
import { socialRepository } from '@/infrastructure/social-repository';

/**
 * 期限の来た SNS 投稿を配信する（035-social-publishing 設計 §6.5）。
 *
 * ジョブ `social.publish` の本体。**`AuthorizationContext` を持たない**（設計 §6.5.2 末尾）。
 * 本体の処理として走るので Repository を直接使い、UseCase を通らない。
 *
 * 守っていること：
 *
 * * **着手印を先にコミットしてから `publish()` を呼ぶ**（§6.5.4）。
 *   同じトランザクションに入れると、プロセスが死んだときに印がロールバックされ、
 *   次の実行が同じ投稿をもう一度送る。SNS の投稿は取り消せない
 * * **`publish()` は直列に呼ぶ**（§6.5.2）。同じ provider の API を同時に叩くと
 *   Rate Limit を自分で踏む
 * * **「配信の支度ができていない」投稿は触らずに飛ばす**（要件 §4 裁定 #8）。
 *   配信 Plugin が無い・資格情報が未設定は失敗ではない。支度が整えば次の周期で配信される
 * * **資格情報の平文を外へ出さない**（§6.5.5）。`Secret.expose()` を呼ぶのはこのファイルだけ
 */

/** `job_runs.summary` になる（設計 §6.5.7）。**固定キーの数値だけ。** */
export type PublishSummary = {
  /** 前回の実行が途中で死んでいた件数（`failed` に落とした）。 */
  readonly interrupted: number;
  /** 取り出した件数（≤ `PUBLISH_BATCH_SIZE`）。 */
  readonly due: number;
  /** 配信の支度ができておらず**触らなかった**件数。 */
  readonly skipped: number;
  /** 着手して結果まで進んだ件数（= published + retried + failed + unrecorded）。 */
  readonly attempted: number;
  readonly published: number;
  readonly retried: number;
  readonly failed: number;
  /** 結果を書き戻せなかった件数（着手印が外から消された）。 */
  readonly unrecorded: number;
};

export interface PublishDueOptions {
  /**
   * `publish()` 1 回の上限（ミリ秒）。省略すると `PUBLISH_TIMEOUT_MS`。
   *
   * **ジョブ定義は渡さない**（実装プラン §8 の 2）。結合テストが実時間で待たないための口。
   */
  readonly timeoutMs?: number;
}

type PublishFn = NonNullable<PublisherRegistration['publish']>;

/** 1 行の配信が行き着いた先。`summary` の内訳になる。 */
type RowOutcome = 'published' | 'retried' | 'failed' | 'unrecorded';

/** `publish()` を 1 回呼んだ結果と、返ってきた更新後の資格情報。 */
interface Attempt {
  readonly result: PublishAttemptResult;
  readonly rotated: Readonly<Record<string, string>> | null;
}

type CredentialResolution =
  | { readonly ok: true; readonly values: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly reason: string };

// ---------------------------------------------------------------------------
// Plugin へ渡す形
// ---------------------------------------------------------------------------

/**
 * `credentialFields` を Domain の型へ落とす。
 *
 * **Domain は `@torifune/plugin-api` を知らない**（設計 §4.1）。写すのは Application の仕事。
 */
function credentialFieldsOf(registration: PublisherRegistration): readonly CredentialField[] {
  return registration.credentialFields.map((field) => ({ key: field.key, kind: field.kind }));
}

function toPostView(post: SocialPost): SocialPostView {
  return {
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    failureReason: post.failureReason,
    deliveryMode: post.deliveryMode,
    media: post.media.map((item) => ({ url: item.url, alt: item.alt })),
    link: post.link,
    providerOptions: post.providerOptions,
    externalRef: post.externalRef,
    externalId: post.externalId,
    externalUrl: post.externalUrl,
    failedAt: post.failedAt?.toISOString() ?? null,
  };
}

function toAccountView(account: SocialAccount): SocialAccountView {
  return {
    id: account.id,
    provider: account.provider,
    displayName: account.displayName,
    handle: account.handle,
    status: account.status,
    credentialConfigured: account.credentialConfigured,
  };
}

/**
 * publisher へ渡すログの口。
 *
 * **`plugin/logger.ts` を使わない。** Application から `plugin/` を import しない
 * （設計 §4.1、受け入れ条件 #82）。出力の直前で機密キーを落とすのは `log` が行う。
 */
function publisherLogger(pluginId: string): PluginLogger {
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    log[level](message, { pluginId, ...(detail === undefined ? {} : { detail }) });
  };

  return {
    debug: (message, detail) => write('debug', message, detail),
    info: (message, detail) => write('info', message, detail),
    warn: (message, detail) => write('warn', message, detail),
    error: (message, detail) => write('error', message, detail),
  };
}

// ---------------------------------------------------------------------------
// 自由文の秘匿
// ---------------------------------------------------------------------------

/**
 * Plugin 由来の自由文を、記録できる形にする（設計 §6.5.5）。
 *
 * **伏せてから切る。** 逆にすると、途中で切れた値が完全一致の秘匿に掛からず残る。
 */
function safeText(text: string, values: readonly string[]): string {
  return redactCredentialValues(redactSecrets(text), values);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `reason` / 例外メッセージから資格情報の値を伏せる。判断は `decidePublishOutcome` が行う。 */
function redactAttemptResult(
  result: PublishAttemptResult,
  values: readonly string[],
): PublishAttemptResult {
  if (result.type === 'thrown') {
    return { type: 'thrown', message: safeText(result.message, values) };
  }
  if (result.type === 'result' && !result.ok) {
    return { ...result, reason: safeText(result.reason, values) };
  }
  return result;
}

/** 保存する直前に長さをそろえる。空になったものは理由なしとして空文字にする。 */
function normalizedVerdict(verdict: PublishVerdict): PublishVerdict {
  if (verdict.kind === 'published') {
    return verdict;
  }
  const reason = normalizeFailureReason(verdict.reason) ?? '';
  return verdict.kind === 'retry' ? { ...verdict, reason } : { kind: 'failed', reason };
}

// ---------------------------------------------------------------------------
// 資格情報
// ---------------------------------------------------------------------------

/**
 * その 1 アカウントぶんの資格情報を取り出す（設計 §6.5.2 の c）。
 *
 * **「まだ設定していない」はここへ来ない**（a で飛ばしてある）。来たら壊れているとみなす。
 * 復号できない・宣言と形が合わないものは `failed` にする。
 */
async function resolveCredential(
  connection: Connection,
  account: SocialAccount,
  fields: readonly CredentialField[],
): Promise<CredentialResolution> {
  // 資格情報の要らない配信手段。**読まずに `{}` を渡す**（設計 §5.7）。
  if (fields.length === 0) {
    return { ok: true, values: {} };
  }

  const withCredential = await socialRepository.findAccountWithCredential(connection, account.id);
  if (withCredential === null) {
    return { ok: false, reason: CREDENTIAL_MISSING_REASON };
  }
  if (withCredential.credential === null) {
    // 列に値があるのに `credential` が null ＝ 復号できなかった（Repository が「無い」に倒している）。
    return {
      ok: false,
      reason: withCredential.credentialConfigured
        ? CREDENTIAL_UNREADABLE_REASON
        : CREDENTIAL_MISSING_REASON,
    };
  }

  // **`Secret.expose()` を新たに呼ぶのはこの 1 か所だけ**（設計 §6.5.5、受け入れ条件 #83）。
  const parsed = parseCredentialObject(withCredential.credential.expose());
  const keys = fields.map((field) => field.key);
  if (parsed === null) {
    return { ok: false, reason: credentialMismatchReason(keys) };
  }
  if (validateCredentialAgainstFields(parsed, fields).length > 0) {
    return { ok: false, reason: credentialMismatchReason(keys) };
  }

  return { ok: true, values: parsed };
}

/**
 * `rotatedCredential` を書き戻す（設計 §6.5.6）。
 *
 * **投稿の書き戻しとは別のトランザクションで、先に行う**（実装プラン §7 の 9）。
 * 投稿側が 0 行でも、トークンが更新された事実は変わらない。
 * 宣言に合わないものは書かずに警告するだけで、投稿の結果には影響しない。
 */
async function rotateCredential(
  connection: Connection,
  params: {
    readonly accountId: string;
    readonly pluginId: string;
    readonly fields: readonly CredentialField[];
    readonly rotated: Readonly<Record<string, string>>;
  },
): Promise<void> {
  const { accountId, pluginId } = params;

  if (validateCredentialAgainstFields(params.rotated, params.fields).length > 0) {
    log.warn('rotated credential does not match the declared fields', { accountId, pluginId });
    return;
  }

  const plaintext = JSON.stringify(params.rotated);
  if (plaintext.length > CREDENTIAL_MAX_LENGTH) {
    log.warn('rotated credential is too long', { accountId, pluginId });
    return;
  }

  const encryptedCredential = encryptSecret(plaintext);
  const updated = await connection.transaction((tx) =>
    socialRepository.updateAccount(tx, accountId, { encryptedCredential }),
  );
  if (updated === null) {
    log.warn('rotated credential could not be saved', { accountId, pluginId });
    return;
  }

  await recordSystemAudit(connection, {
    action: 'updated',
    resourceType: 'social_account',
    resourceId: accountId,
    detail: { changed: ['credential'], rotated: true, pluginId },
  });
}

// ---------------------------------------------------------------------------
// publish() の呼び出し
// ---------------------------------------------------------------------------

function toAttempt(result: PublishResult): Attempt {
  if (result.ok) {
    return {
      result: {
        type: 'result',
        ok: true,
        ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        ...(result.externalUrl === undefined ? {} : { externalUrl: result.externalUrl }),
      },
      rotated: result.rotatedCredential ?? null,
    };
  }
  return {
    result: {
      type: 'result',
      ok: false,
      reason: result.reason,
      retryable: result.retryable,
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    },
    rotated: null,
  };
}

/**
 * `publish()` を制限時間つきで 1 回呼ぶ。
 *
 * **`AbortSignal` を渡すだけでは打ち切れない**（実装プラン §7 の 7）。
 * `signal` を見ない publisher は解決しないままなので、`Promise.race` で Core 側が先へ進む。
 * 放置された Promise は握って `unhandledRejection` にしない。
 */
async function callPublish(
  publish: PublishFn,
  input: PublishInput,
  controller: AbortController,
  timeoutMs: number,
): Promise<Attempt> {
  const thrown = (error: unknown): Attempt => ({
    result: { type: 'thrown', message: messageOf(error) },
    rotated: null,
  });

  let running: Promise<Attempt>;
  try {
    running = Promise.resolve(publish(input)).then(toAttempt, thrown);
  } catch (error) {
    // 同期で投げる publisher（`async` でない実装）。
    running = Promise.resolve(thrown(error));
  }
  void running.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Attempt>((resolve) => {
    timer = setTimeout(() => {
      // 見ている publisher には打ち切りを伝える。見ていなくても Core は待たない。
      controller.abort();
      resolve({ result: { type: 'timeout' }, rotated: null });
    }, timeoutMs);
  });

  try {
    return await Promise.race([running, timedOut]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// ---------------------------------------------------------------------------
// 1 行ぶんの配信
// ---------------------------------------------------------------------------

interface PublishOneInput {
  readonly connection: Connection;
  /** 着手印を立てた後の行。 */
  readonly post: SocialPost;
  readonly account: SocialAccount;
  readonly publisher: RegisteredPublisher;
  readonly publish: PublishFn;
  readonly fields: readonly CredentialField[];
  readonly attempt: number;
  readonly timeoutMs: number;
}

/** 結果を書き戻し、ログとイベントを出す（設計 §6.5.2 の f・g）。 */
async function recordAndReport(
  input: PublishOneInput,
  verdict: PublishVerdict,
  durationMs: number,
): Promise<RowOutcome> {
  const { connection, post, account, publisher } = input;
  const fields = {
    postId: post.id,
    accountId: account.id,
    provider: account.provider,
    pluginId: publisher.pluginId,
    attempt: input.attempt,
  };

  const stored = normalizedVerdict(verdict);
  const updated = await socialRepository.recordOutcome(connection, post.id, stored);
  if (updated === 0) {
    // 別プロセスの中断判定で着手印が消された（設計 §6.5.6）。**イベントは出さない。**
    log.warn('publish result could not be recorded', { ...fields, verdict: stored.kind });
    return 'unrecorded';
  }

  if (stored.kind === 'published') {
    log.info('social post published', { ...fields, durationMs });
    await emit('social.post.published', {
      postId: post.id,
      accountId: account.id,
      status: 'published',
    });
    return 'published';
  }

  if (stored.kind === 'retry') {
    log.warn('social post publish retried', {
      ...fields,
      nextAttemptAt: stored.nextAttemptAt.toISOString(),
      reason: stored.reason,
    });
    return 'retried';
  }

  log.error('social post publish failed', { ...fields, reason: stored.reason });
  await emit('social.post.failed', {
    postId: post.id,
    accountId: account.id,
    status: 'failed',
  });
  return 'failed';
}

/** 着手印を立てた 1 行を配信する（設計 §6.5.2 の c〜g）。 */
async function publishOne(input: PublishOneInput): Promise<RowOutcome> {
  const { connection, post, account, publisher, fields, attempt } = input;

  // c: 資格情報。
  const resolved = await resolveCredential(connection, account, fields);
  if (!resolved.ok) {
    return recordAndReport(input, { kind: 'failed', reason: resolved.reason }, 0);
  }
  const credential = resolved.values;
  const secretValues = Object.values(credential);

  // **監査の記録を試みてから `publish()` を呼ぶ**（設計 §6.5.8）。
  // 値もキー名も残さない。
  if (fields.length > 0) {
    await recordSystemAudit(connection, {
      action: 'credential_read',
      resourceType: 'social_account',
      resourceId: account.id,
      detail: {
        purpose: 'publish',
        postId: post.id,
        provider: account.provider,
        pluginId: publisher.pluginId,
        attempt,
      },
    });
  }

  // d: 配信。
  const controller = new AbortController();
  const beganAt = Date.now();
  const publishInput: PublishInput = {
    post: toPostView(post),
    account: toAccountView(account),
    credential,
    attempt,
    signal: controller.signal,
    logger: publisherLogger(publisher.pluginId),
  };
  const outcome = await callPublish(input.publish, publishInput, controller, input.timeoutMs);
  const durationMs = Date.now() - beganAt;

  const verdict = decidePublishOutcome(
    redactAttemptResult(outcome.result, secretValues),
    attempt,
    new Date(),
  );

  // e: 更新後の資格情報は**投稿の書き戻しより先に**、別のトランザクションで。
  if (outcome.rotated !== null) {
    await rotateCredential(connection, {
      accountId: account.id,
      pluginId: publisher.pluginId,
      fields,
      rotated: outcome.rotated,
    });
  }

  return recordAndReport(input, verdict, durationMs);
}

// ---------------------------------------------------------------------------
// ジョブ本体
// ---------------------------------------------------------------------------

/** 期限の来た投稿のアカウントをまとめて引く（同じアカウントは 1 回だけ）。 */
async function accountsOf(
  connection: Connection,
  posts: readonly SocialPost[],
): Promise<Map<string, SocialAccount>> {
  const accounts = new Map<string, SocialAccount>();
  for (const post of posts) {
    if (accounts.has(post.socialAccountId)) {
      continue;
    }
    const account = await socialRepository.findAccountById(connection, post.socialAccountId);
    if (account !== null) {
      accounts.set(account.id, account);
    }
  }
  return accounts;
}

/** publisher を持たない provider を **provider ごとに 1 行だけ** 警告する（設計 §6.5.7）。 */
function warnMissingPublishers(
  posts: readonly SocialPost[],
  accounts: Map<string, SocialAccount>,
): void {
  const counts = new Map<string, number>();
  for (const post of posts) {
    const account = accounts.get(post.socialAccountId);
    if (account === undefined) {
      continue;
    }
    const publisher = findPublisher(account.provider);
    if (publisher === null || publisher.registration.publish === undefined) {
      counts.set(account.provider, (counts.get(account.provider) ?? 0) + 1);
    }
  }
  for (const [provider, count] of counts) {
    log.warn('social publisher is not registered', { provider, count });
  }
}

export async function publishDuePosts(
  connection: Connection,
  options: PublishDueOptions = {},
): Promise<PublishSummary> {
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  const counters = {
    interrupted: 0,
    due: 0,
    skipped: 0,
    attempted: 0,
    published: 0,
    retried: 0,
    failed: 0,
    unrecorded: 0,
  };

  // 1. 中断行を `failed` に落とす（設計 §6.5.4）。**再送しない。**
  const interrupted = await socialRepository.failInterrupted(connection, INTERRUPTED_REASON);
  counters.interrupted = interrupted.length;
  for (const row of interrupted) {
    log.error('social post interrupted', { postId: row.id });
    await emit('social.post.failed', {
      postId: row.id,
      accountId: row.socialAccountId,
      status: 'failed',
    });
  }

  // 2. 期限の来た自動配信の投稿（設計 §6.5.3）。
  const due = await socialRepository.listDue(connection, PUBLISH_BATCH_SIZE);
  counters.due = due.length;

  const accounts = await accountsOf(connection, due);
  warnMissingPublishers(due, accounts);
  const warnedAccounts = new Set<string>();

  // 3. 行ごとに。**直列。並列にしない**（設計 §6.5.2）。
  for (const post of due) {
    const account = accounts.get(post.socialAccountId);
    if (account === undefined) {
      counters.skipped += 1;
      continue;
    }

    // a: 配信の支度ができているか。**着手印を書く前に判定する**（要件 §4 裁定 #8）。
    const publisher = findPublisher(account.provider);
    const publish = publisher?.registration.publish;
    if (publisher === null || publish === undefined) {
      counters.skipped += 1;
      continue;
    }

    const fields = credentialFieldsOf(publisher.registration);
    if (fields.length > 0 && !account.credentialConfigured) {
      // **「まだ設定していない」を `failed` にしない。** 支度が整えば次の周期で配信される。
      if (!warnedAccounts.has(account.id)) {
        warnedAccounts.add(account.id);
        log.warn('social account credential is not configured', {
          accountId: account.id,
          provider: account.provider,
        });
      }
      counters.skipped += 1;
      continue;
    }

    // b: 着手印。**自分のトランザクションでコミットしてから `publish()` を呼ぶ。**
    const claimed = await socialRepository.claimForPublish(connection, post.id);
    if (claimed === null) {
      // 誰かが先に触った。行は相手のものなので何もしない。
      continue;
    }

    // 例外はどこで出ても**その行だけ**を止める（設計 §6.5.2）。
    let outcome: RowOutcome;
    try {
      outcome = await publishOne({
        connection,
        post: claimed,
        account,
        publisher,
        publish,
        fields,
        attempt: claimed.attemptCount,
        timeoutMs,
      });
    } catch (error) {
      log.error('social post publish aborted', {
        postId: post.id,
        accountId: account.id,
        provider: account.provider,
        pluginId: publisher.pluginId,
        reason: redactSecrets(messageOf(error)),
      });
      outcome = 'unrecorded';
    }

    counters.attempted += 1;
    counters[outcome] += 1;
  }

  return { ...counters };
}
