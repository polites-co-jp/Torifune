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
import {
  normalizeFailureReason,
  toAccountView,
  toPostView,
} from '@/application/social/social-use-cases';
import type { Connection } from '@/database/provider';
import {
  CREDENTIAL_MAX_LENGTH,
  parseCredentialObject,
  validateCredentialAgainstFields,
  type CredentialField,
} from '@/domain/social/credential';
import {
  checkPublisherLimits,
  credentialMismatchReason,
  CREDENTIAL_MISSING_REASON,
  CREDENTIAL_UNREADABLE_REASON,
  decidePublishOutcome,
  decideSkipOutcome,
  INTERRUPTED_REASON,
  PUBLISH_BATCH_SIZE,
  PUBLISH_PAGE_SIZE,
  PUBLISH_SCAN_LIMIT,
  PUBLISH_TIMEOUT_MS,
  publisherRejectedReason,
  redactCredentialValues,
  VALIDATE_TIMEOUT_MS,
  validateErrorReason,
  type PublishAttemptResult,
  type PublishVerdict,
  type SkipReason,
} from '@/domain/social/publishing';
import type { SocialAccount, SocialPost } from '@/domain/social/social';
import type { DueCursor } from '@/domain/social/social-repository';
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
 * * **「配信の支度ができていない」投稿は後ろへ送る**（要件 §4 裁定 #8・#9）。
 *   配信 Plugin が無い・資格情報が未設定は失敗ではない。支度が整えば次の周期で配信される。
 *   ただし**行に痕跡を残さないと、その行が取り出しの先頭に居座り続けて
 *   他のアカウントの配信まで止まる**ので、`next_attempt_at` を置いて後ろへ送り、
 *   同じ理由で 3 回飛ばされたら `failed` にして順番待ちから外す（§6.5.2.1）
 * * **資格情報の平文を外へ出さない**（§6.5.5）。`Secret.expose()` を呼ぶのはこのファイルだけ
 */

/** `job_runs.summary` になる（設計 §6.5.7）。**固定キーの数値だけ。** */
export type PublishSummary = {
  /** 前回の実行が途中で死んでいた件数（`failed` に落とした）。 */
  readonly interrupted: number;
  /**
   * **走査して判定した期限到来の行の件数**（≤ `PUBLISH_SCAN_LIMIT`）。
   *
   * 飛ばした行（`skipped` / `skipFailed`）も含む。
   * **取り出し枠（`PUBLISH_BATCH_SIZE`）は `attempted` のほうに掛かる**（設計 §6.5.7）。
   * `due` が `PUBLISH_SCAN_LIMIT` に等しい周期は、まだ見ていない期限到来の行が残っている。
   */
  readonly due: number;
  /** 配信の支度ができておらず**後ろへ送った**件数（`scheduled` のまま残る）。 */
  readonly skipped: number;
  /**
   * 同じ理由で 3 回飛ばされ、**諦めて `failed` にした**件数。
   *
   * **`failed` と混ぜない。** あちらは `publish()` を呼んだうえでの失敗で、
   * 運用者が次にすべきことが違う。
   */
  readonly skipFailed: number;
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
  /**
   * 配信直前の `validate()` 1 回の上限（ミリ秒）。省略すると `VALIDATE_TIMEOUT_MS`。
   *
   * `timeoutMs` と同じく、結合テストが実時間で待たないための口。
   */
  readonly validateTimeoutMs?: number;
  /**
   * 1 回の実行で**見る**行の上限。省略すると `PUBLISH_SCAN_LIMIT`（200）。
   *
   * **ジョブ定義は渡さない**（環境変数にもしない。設計 §6.5.3 / §11 #22）。
   * 結合テストが 200 行を作らずに打ち切りを見るための口。
   */
  readonly scanLimit?: number;
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

/**
 * 入れ子をたどる深さの上限（設計 §6.5.5）。
 *
 * `fields` は Plugin が書く任意の構造なので、循環と深い木で回り続けないための蓋。
 */
const REDACT_MAX_DEPTH = 5;

/**
 * 深さ上限を超えた枝に置く印（設計 §6.5.5、検証レポート §9.2 の R-8）。
 *
 * **伏せられないなら出さない。** 深さ上限は「たどるのをやめる」ための仕組みであって、
 * 「素通しする」ための仕組みではない。落として困る Plugin は、浅いところに書けばよい。
 */
const DEPTH_LIMIT_MARK = '[depth limit]';

/**
 * 自由文の中の資格情報を伏せる（文字列だけを置き換え、構造は壊さない）。
 *
 * Plugin が `logger.info('x', { pw: credential.appPassword })` と書いても、
 * `maskSecrets` はキー名しか見ないので値が残る。**値まで機構で落とす**（設計 §6.5.5、L-1）。
 *
 * 深さ上限を超えた枝は、**値をそのまま返さずに落とす**（R-8）。
 * 素通しすると、深いところに置かれた文字列に伏せ字が掛からず平文で出る。
 */
function redactDeep(value: unknown, values: readonly string[], depth = 0): unknown {
  if (typeof value === 'string') {
    return redactCredentialValues(value, values);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  // **これ以上たどれない枝は、中身を返さずに落とす**（R-8）。
  // 返すと、その先に置かれた文字列が伏せ字を通らずに平文で出る。
  if (depth >= REDACT_MAX_DEPTH) {
    return DEPTH_LIMIT_MARK;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(item, values, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactDeep(item, values, depth + 1);
  }
  return result;
}

/**
 * publisher へ渡すログの口。
 *
 * **`plugin/logger.ts` を使わない。** Application から `plugin/` を import しない
 * （設計 §4.1、受け入れ条件 #82）。出力の直前で機密キーを落とすのは `log` が行う。
 *
 * それに加えて、**`message` と `fields` の文字列値へその行の資格情報の伏せ字を掛ける**
 * （設計 §6.5.5、検証レポート L-1）。契約でなく機構で守れるものは機構で守る。
 * **握りつぶさない。** 伏せたうえで Plugin のログ自体は残す。
 */
function publisherLogger(pluginId: string, secretValues: readonly string[]): PluginLogger {
  const write = (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    detail?: Record<string, unknown>,
  ): void => {
    log[level](redactCredentialValues(message, secretValues), {
      pluginId,
      ...(detail === undefined ? {} : { detail: redactDeep(detail, secretValues) }),
    });
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
  readonly validateTimeoutMs: number;
}

/** 配信直前の `validate()` の結果。例外も制限時間超過も同じ「エラー」に畳む。 */
type ValidateOutcome =
  | { readonly type: 'ok'; readonly problems: readonly { field: string; message: string }[] }
  | { readonly type: 'error'; readonly message: string };

/**
 * 配信直前の `validate()` を制限時間つきで 1 回呼ぶ（設計 §6.5.2.2）。
 *
 * `publish()` と同じく、**解決しない Promise に実行を止めさせない**。
 * 放置された Promise は握って `unhandledRejection` にしない。
 */
async function callValidate(
  validate: NonNullable<PublisherRegistration['validate']>,
  input: { readonly post: SocialPostView; readonly account: SocialAccountView },
  timeoutMs: number,
): Promise<ValidateOutcome> {
  const failed = (error: unknown): ValidateOutcome => ({
    type: 'error',
    message: messageOf(error),
  });

  let running: Promise<ValidateOutcome>;
  try {
    running = Promise.resolve(validate(input)).then(
      (problems) => ({ type: 'ok', problems: [...problems] }) satisfies ValidateOutcome,
      failed,
    );
  } catch (error) {
    // 同期で投げる publisher。
    running = Promise.resolve(failed(error));
  }
  void running.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ValidateOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({ type: 'error', message: '検査が制限時間内に終わりませんでした。' });
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

/**
 * 配信直前の再検査（設計 §6.5.2.2、検証レポート S-2）。
 *
 * **publisher が無い間に登録された投稿は `limits` も `validate()` も一度も通っていない。**
 * 裁定 #8 で「配信 Plugin が無くても予約できる」ことにした以上、
 * その投稿にとって**配信時が唯一の判定機会**である。
 *
 * 通らなければ `publish()` を呼ばずに `failed`。**再試行しない**
 * （宣言に合わない投稿は、時間が経っても合うようにはならない）。
 * 理由は「未送信」と読める文言にし、「結果不明」と混ぜない。
 *
 * この時点では資格情報をまだ復号していないので、伏せるのは `redactSecrets` だけ。
 */
async function precheck(input: PublishOneInput): Promise<PublishVerdict | null> {
  const { registration } = input.publisher;

  // 1: publisher が宣言した上限。**§6.1.2 の j〜l と同じ関数**を使う。
  //
  // **Plugin 由来の自由文は `message` だけではない**（検証レポート §9.2 の R-5）。
  // `publisherRejectedReason` が埋め込む `registration.label`（表示名）も、
  // `checkPublisherLimits` が返す `field` / `message` も**すべて Plugin が書いた文字列**である。
  // `validate()` 経路と同じ関数を通してから理由文にする（経路によって差を作らない）。
  const limitProblems = checkPublisherLimits(
    input.post,
    registration.limits ?? {},
    registration.label,
  );
  if (limitProblems.length > 0) {
    return {
      kind: 'failed',
      reason: publisherRejectedReason(
        limitProblems.map((problem) => ({
          field: redactSecrets(problem.field),
          message: redactSecrets(problem.message),
        })),
      ),
    };
  }

  if (registration.validate === undefined) {
    return null;
  }

  // 2・3: publisher 自身の検査。例外・制限時間超過も**未送信**として扱う。
  const outcome = await callValidate(
    registration.validate,
    { post: toPostView(input.post), account: toAccountView(input.account) },
    input.validateTimeoutMs,
  );

  if (outcome.type === 'error') {
    log.warn('social publisher validate failed before publish', {
      postId: input.post.id,
      accountId: input.account.id,
      provider: input.account.provider,
      pluginId: input.publisher.pluginId,
    });
    return { kind: 'failed', reason: validateErrorReason(redactSecrets(outcome.message)) };
  }
  if (outcome.problems.length === 0) {
    return null;
  }

  return {
    kind: 'failed',
    reason: publisherRejectedReason(
      outcome.problems.map((problem) => ({
        field: redactSecrets(problem.field),
        message: redactSecrets(problem.message),
      })),
    ),
  };
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

  // b2: 配信直前の再検査。**`publish()` を呼ぶ前に、着手した行の内容へ掛ける。**
  const rejected = await precheck(input);
  if (rejected !== null) {
    return recordAndReport(input, rejected, 0);
  }

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
    logger: publisherLogger(publisher.pluginId, secretValues),
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

/** 走査で着手できると判断した 1 行。**2 で引いたものを 3 へそのまま持ち回る**（設計 §6.5.2）。 */
interface ReadyRow {
  readonly post: SocialPost;
  readonly account: SocialAccount;
  readonly publisher: RegisteredPublisher;
  readonly publish: PublishFn;
  readonly fields: readonly CredentialField[];
}

export async function publishDuePosts(
  connection: Connection,
  options: PublishDueOptions = {},
): Promise<PublishSummary> {
  const timeoutMs = options.timeoutMs ?? PUBLISH_TIMEOUT_MS;
  const validateTimeoutMs = options.validateTimeoutMs ?? VALIDATE_TIMEOUT_MS;
  const scanLimit = options.scanLimit ?? PUBLISH_SCAN_LIMIT;
  const counters = {
    interrupted: 0,
    due: 0,
    skipped: 0,
    skipFailed: 0,
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

  // 同じアカウントを二度引かない。走査（2）で引いたものを配信（3）へ持ち回る。
  const accounts = new Map<string, SocialAccount | null>();
  const accountOf = async (id: string): Promise<SocialAccount | null> => {
    const cached = accounts.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const account = await socialRepository.findAccountById(connection, id);
    accounts.set(id, account);
    return account;
  };

  /** publisher が無い provider は **provider ごとに 1 行だけ** 警告する（設計 §6.5.7）。 */
  const missingPublisherCounts = new Map<string, number>();
  const warnedAccounts = new Set<string>();

  /**
   * 飛ばす行を後ろへ送る（設計 §6.5.2.1）。
   *
   * **着手印は書かない**ので `attempt_count` は 0 のまま。
   * 同じ理由で 3 回飛ばされたら `failed` にして順番待ちから外す。
   */
  const defer = async (
    post: SocialPost,
    reason: SkipReason,
    provider: string | null,
  ): Promise<void> => {
    const verdict = decideSkipOutcome(post, reason, new Date());
    const updated = await socialRepository.deferSkipped(connection, post.id, verdict);
    if (updated === 0) {
      // その間に人が触った。次の周期で判定し直す。
      return;
    }

    if (verdict.kind === 'deferred') {
      counters.skipped += 1;
      return;
    }

    counters.skipFailed += 1;
    log.error('social post skipped too many times', {
      postId: post.id,
      provider,
      reason: verdict.reason,
      skipCount: verdict.skipCount,
    });
    await emit('social.post.failed', {
      postId: post.id,
      accountId: post.socialAccountId,
      status: 'failed',
    });
  };

  // 2. **着手できる行を集める**（設計 §6.5.3）。
  //
  // **`PUBLISH_BATCH_SIZE` は「送る行」の上限、`scanLimit` は「読む行」の上限。**
  // 飛ばした行は送る枠を食わずに後ろへ送られ、着手できる行が枠ぶん集まるか
  // 走査上限に達するまで読み進める（裁定 #12-b）。
  //
  // ここでは **Plugin を呼ばない。** `publish()`（最長 30 秒）は 3 でだけ呼ぶので、
  // 飛ばした行の判定に外部 I/O の時間が混ざらない。
  const ready: ReadyRow[] = [];
  let cursor: DueCursor | null = null;
  /**
   * カーソルが進まないので走査を打ち切った（設計 §6.5.3、3 回目の検証の低-B）。
   *
   * `scheduled_at` はマイクロ秒まで持てるのに、カーソルへ載せる値はミリ秒までしか持てない。
   * ミリ秒未満の端数を持つ行があると**同じページが返り続ける**。打ち切らないと
   * 同じ投稿が `ready` に何度も積まれ、`retry` で着手印が外れた行を
   * **同じ実行の中で二度以上 claim する**（SNS の投稿は取り消せない）。
   */
  let stalled = false;
  while (ready.length < PUBLISH_BATCH_SIZE && counters.due < scanLimit) {
    const page = await socialRepository.listDue(
      connection,
      Math.min(PUBLISH_PAGE_SIZE, scanLimit - counters.due),
      cursor,
    );
    if (page.length === 0) {
      // 期限の来た行が尽きた。
      break;
    }

    for (const post of page) {
      // **`OFFSET` を使わない**（設計 §6.5.3）。飛ばした行・着手した行は条件から外れるので、
      // `OFFSET` だと外れた数だけ後ろの行を読み飛ばす。
      const next: DueCursor = { scheduledAt: post.scheduledAt ?? new Date(0), id: post.id };
      // **カーソルが前回と同値なら打ち切る**（設計 §6.5.3）。進んでいる限り何も変えない。
      if (
        cursor !== null &&
        cursor.id === next.id &&
        cursor.scheduledAt.getTime() === next.scheduledAt.getTime()
      ) {
        stalled = true;
        break;
      }
      cursor = next;
      counters.due += 1;

      const account = await accountOf(post.socialAccountId);
      if (account === null) {
        // FK があるので通常は起きない防御。
        await defer(post, 'account_missing', null);
        continue;
      }

      // a: 配信の支度ができているか。**着手印を書く前に判定する**（要件 §4 裁定 #8・#9）。
      const publisher = findPublisher(account.provider);
      const publish = publisher?.registration.publish;
      if (publisher === null || publish === undefined) {
        missingPublisherCounts.set(
          account.provider,
          (missingPublisherCounts.get(account.provider) ?? 0) + 1,
        );
        await defer(post, 'no_publisher', account.provider);
        continue;
      }

      const fields = credentialFieldsOf(publisher.registration);
      if (fields.length > 0 && !account.credentialConfigured) {
        // **「まだ設定していない」を その場で `failed` にしない。** 支度が整えば配信される。
        if (!warnedAccounts.has(account.id)) {
          warnedAccounts.add(account.id);
          log.warn('social account credential is not configured', {
            accountId: account.id,
            provider: account.provider,
          });
        }
        await defer(post, 'credential_missing', account.provider);
        continue;
      }

      // a': 支度ができている。作業列へ積む。
      ready.push({ post, account, publisher, publish, fields });
      if (ready.length >= PUBLISH_BATCH_SIZE) {
        break;
      }
    }

    if (stalled) {
      log.warn('social publish scan cursor did not advance', {
        scheduledAt: cursor?.scheduledAt.toISOString() ?? null,
        postId: cursor?.id ?? null,
      });
      break;
    }
  }

  for (const [provider, count] of missingPublisherCounts) {
    log.warn('social publisher is not registered', { provider, count });
  }

  // 3. **送る。** 行ごとに直列。並列にしない（設計 §6.5.2）。
  for (const row of ready) {
    const { post, account, publisher, publish, fields } = row;

    // b: 着手印。**自分のトランザクションでコミットしてから `publish()` を呼ぶ。**
    // 2 と 3 のあいだに人が触った行は 0 行で弾かれる（従来どおり）。
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
        validateTimeoutMs,
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
