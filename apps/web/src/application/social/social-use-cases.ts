import { uuidv7 } from 'uuidv7';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import { NotFoundError, ValidationError } from '@/domain/repository';
import type { Secret } from '@/domain/secret';
import {
  canTransition,
  DELIVERED_STATUSES,
  FAILURE_REASON_MAX_LENGTH,
  isValidDisplayName,
  isValidPostBody,
  isValidProvider,
  type AccountStatus,
  type PostStatus,
  type SocialAccount,
  type SocialPost,
} from '@/domain/social/social';
import type { SocialAccountPage, SocialPostPage } from '@/domain/social/social-repository';
import { encryptSecret } from '@/infrastructure/crypto/cipher';
import { socialRepository } from '@/infrastructure/social-repository';

/**
 * SNSアカウントと投稿の UseCase。
 *
 * **外部SNSへの実投稿は行わない**（Plugin の責務）。
 * ここが扱うのはデータと状態だけ。
 */

// ---------------------------------------------------------------------------
// アカウント
// ---------------------------------------------------------------------------

export interface ListAccountsInput {
  readonly page: number;
  readonly perPage: number;
  readonly provider: string | null;
}

export const listSocialAccounts = defineUseCase<ListAccountsInput, SocialAccountPage>({
  name: 'social.account.list',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listAccounts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      provider: input.provider,
    }),
});

export const getSocialAccount = defineUseCase<{ id: string }, SocialAccount>({
  name: 'social.account.get',
  permission: 'social.read',
  handler: async (context, input) => {
    const account = await socialRepository.findAccountById(context.connection, input.id);
    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account;
  },
});

export interface CreateAccountInput {
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
  /** 平文。**保存前に暗号化する。** */
  readonly credential: string | null;
  readonly status: AccountStatus;
}

export const createSocialAccount = defineUseCase<CreateAccountInput, SocialAccount>({
  name: 'social.account.create',
  permission: 'social.write',
  audit: {
    action: 'created',
    resourceType: 'social_account',
    resourceId: (_input, account) => account.id,
    // 認証情報は残さない。どのSNSのアカウントかが分かれば追跡できる。
    detail: (_input, account) => ({ provider: account.provider }),
  },
  handler: async (context, input) => {
    if (!isValidProvider(input.provider)) {
      throw new ValidationError(
        'SocialAccount',
        'provider',
        '英小文字・数字・アンダースコアで指定してください。',
      );
    }
    if (!isValidDisplayName(input.displayName)) {
      throw new ValidationError('SocialAccount', 'displayName', '表示名を入力してください。');
    }

    const account = await context.connection.transaction((tx) =>
      socialRepository.insertAccount(tx, {
        id: uuidv7(),
        provider: input.provider,
        displayName: input.displayName.trim(),
        handle: input.handle,
        // 平文をそのまま保存しない。
        encryptedCredential:
          input.credential === null || input.credential === ''
            ? null
            : encryptSecret(input.credential),
        status: input.status,
      }),
    );

    // ペイロードに資格情報を含めない。Plugin へ渡ると、そこから漏れる。
    await emit('social.account.connected', {
      accountId: account.id,
      provider: account.provider,
      displayName: account.displayName,
    });

    return account;
  },
});

export interface UpdateAccountInput {
  readonly id: string;
  readonly displayName?: string | undefined;
  readonly handle?: string | undefined;
  readonly status?: AccountStatus | undefined;
  /**
   * `undefined` なら変えない。空文字なら消す。
   * **「指定しない」と「消す」を区別する。**
   * 区別しないと、表示名だけ直したつもりで資格情報が消える。
   */
  readonly credential?: string | undefined;
}

export const updateSocialAccount = defineUseCase<UpdateAccountInput, SocialAccount>({
  name: 'social.account.update',
  permission: 'social.write',
  audit: {
    action: 'updated',
    resourceType: 'social_account',
    resourceId: (input) => input.id,
    detail: (input) => ({ changed: Object.keys(input).filter((key) => key !== 'id') }),
  },
  handler: async (context, input) => {
    if (input.displayName !== undefined && !isValidDisplayName(input.displayName)) {
      throw new ValidationError('SocialAccount', 'displayName', '表示名を入力してください。');
    }

    const encryptedCredential =
      input.credential === undefined
        ? undefined
        : input.credential === ''
          ? null
          : encryptSecret(input.credential);

    const account = await context.connection.transaction((tx) =>
      socialRepository.updateAccount(tx, input.id, {
        ...(input.displayName === undefined ? {} : { displayName: input.displayName.trim() }),
        ...(input.handle === undefined ? {} : { handle: input.handle }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(encryptedCredential === undefined ? {} : { encryptedCredential }),
      }),
    );

    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account;
  },
});

export const deleteSocialAccount = defineUseCase<{ id: string }, void>({
  name: 'social.account.delete',
  permission: 'social.delete',
  audit: { action: 'deleted', resourceType: 'social_account', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      socialRepository.deleteAccount(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    await emit('social.account.disconnected', { accountId: input.id });
  },
});

/**
 * 資格情報を復号して取り出す。
 *
 * **外部SNSを叩くのは Plugin なので、いずれ Plugin へ渡す経路が要る**（S10）。
 * 呼び出し箇所を限り、監査できる状態を保つ。
 */
export const readSocialCredential = defineUseCase<{ id: string }, Secret | null>({
  name: 'social.account.readCredential',
  // 資格情報の読み出しは書き込み相当の権限を要求する。
  // 読めれば外部サービスで何でもできるため、read では弱すぎる。
  permission: 'social.write',
  handler: async (context, input) => {
    const account = await socialRepository.findAccountWithCredential(context.connection, input.id);
    if (account === null) {
      throw new NotFoundError('SocialAccount', input.id);
    }
    return account.credential;
  },
});

// ---------------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------------

export interface ListPostsInput {
  readonly page: number;
  readonly perPage: number;
  readonly socialAccountId: string | null;
  readonly status: PostStatus | null;
}

export const listSocialPosts = defineUseCase<ListPostsInput, SocialPostPage>({
  name: 'social.post.list',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listPosts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      socialAccountId: input.socialAccountId,
      // 単一指定を配列へ畳む。`listCampaigns` と同じ形。
      statuses: input.status === null ? [] : [input.status],
      orderBy: 'created',
    }),
});

export interface ListPostHistoryInput {
  readonly page: number;
  readonly perPage: number;
  /** 結果で絞る。null なら配信済みと失敗の両方。 */
  readonly status: 'published' | 'failed' | null;
}

/**
 * 配信履歴（06_画面設計.md §13「履歴」）。
 *
 * **試行履歴のテーブルは無い。** `published` / `failed` は終端状態で、
 * 1つの投稿が持つ配信結果は高々1つ。「履歴」とは
 * **配信結果が確定した投稿の一覧**である（026-screen-completion 設計 §4.3）。
 *
 * 並びは結果が確定した順。作成順ではない。
 * 「いつ配信され、いつ失敗したか」を追うための画面なので、
 * 作成順に並べると、古い投稿がいま失敗したことが下の方に埋もれる。
 */
export const listSocialPostHistory = defineUseCase<ListPostHistoryInput, SocialPostPage>({
  name: 'social.post.history',
  permission: 'social.read',
  handler: async (context, input) =>
    socialRepository.listPosts(context.connection, {
      page: input.page,
      perPage: input.perPage,
      socialAccountId: null,
      statuses: input.status === null ? DELIVERED_STATUSES : [input.status],
      orderBy: 'delivered',
    }),
});

/**
 * IDでまとめて引く。
 *
 * キャンペーンに紐づく投稿のように「IDは判っている」場面で使う
 * （026-screen-completion 設計 §3.3）。1件ずつ `getSocialPost` を呼ぶと
 * 件数分の往復になる。
 */
export const listSocialPostsByIds = defineUseCase<
  { ids: readonly string[] },
  readonly SocialPost[]
>({
  name: 'social.post.listByIds',
  permission: 'social.read',
  handler: async (context, input) => socialRepository.findPostsByIds(context.connection, input.ids),
});

export const getSocialPost = defineUseCase<{ id: string }, SocialPost>({
  name: 'social.post.get',
  permission: 'social.read',
  handler: async (context, input) => {
    const post = await socialRepository.findPostById(context.connection, input.id);
    if (post === null) {
      throw new NotFoundError('SocialPost', input.id);
    }
    return post;
  },
});

export interface CreatePostInput {
  readonly socialAccountId: string;
  readonly body: string;
  readonly scheduledAt: Date | null;
  readonly status: PostStatus;
}

export const createSocialPost = defineUseCase<CreatePostInput, SocialPost>({
  name: 'social.post.create',
  permission: 'social.write',
  audit: {
    action: 'created',
    resourceType: 'social_post',
    resourceId: (_input, post) => post.id,
    // 本文は残さない。監査は「誰がいつ何をしたか」であって、内容の複製ではない。
    detail: (_input, post) => ({ socialAccountId: post.socialAccountId, status: post.status }),
  },
  handler: async (context, input) => {
    if (!isValidPostBody(input.body)) {
      throw new ValidationError('SocialPost', 'body', '本文を入力してください（10000文字以内）。');
    }

    // 存在しないアカウントへの投稿を、FK 違反（500）ではなく 422 で返す。
    const account = await socialRepository.findAccountById(
      context.connection,
      input.socialAccountId,
    );
    if (account === null) {
      throw new ValidationError('SocialPost', 'socialAccountId', 'SNSアカウントが見つかりません。');
    }

    const post = await context.connection.transaction((tx) =>
      socialRepository.insertPost(tx, {
        id: uuidv7(),
        socialAccountId: input.socialAccountId,
        body: input.body,
        scheduledAt: input.scheduledAt,
        status: input.status,
      }),
    );

    await emit('social.post.created', {
      postId: post.id,
      accountId: post.socialAccountId,
      status: post.status,
    });

    return post;
  },
});

export interface UpdatePostInput {
  readonly id: string;
  readonly body?: string | undefined;
  readonly scheduledAt?: Date | null | undefined;
  readonly status?: PostStatus | undefined;
  /**
   * 配信に失敗した理由。
   *
   * **これが無かったため、`data.socialPosts.markFailed(id, reason)` が
   * 受け取った理由はどこにも保存されていなかった。**
   * 画面に「失敗」とだけ出て、理由が分からない状態になっていた。
   */
  readonly failureReason?: string | null | undefined;
}

/**
 * 失敗理由を保存できる形にそろえる。
 *
 * **長さで例外にしない。** 外部サービスの応答をそのまま渡す使い方が
 * 想定される場所であり、長かっただけで「失敗の記録が残らない」ほうが困る。
 * 空文字は「理由なし」として null に倒す。
 */
function normalizeFailureReason(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  return trimmed.slice(0, FAILURE_REASON_MAX_LENGTH);
}

export const updateSocialPost = defineUseCase<UpdatePostInput, SocialPost>({
  name: 'social.post.update',
  permission: 'social.write',
  audit: {
    action: 'updated',
    resourceType: 'social_post',
    resourceId: (input) => input.id,
    detail: (input) => ({ changed: Object.keys(input).filter((key) => key !== 'id') }),
  },
  handler: async (context, input) => {
    if (input.body !== undefined && !isValidPostBody(input.body)) {
      throw new ValidationError('SocialPost', 'body', '本文を入力してください（10000文字以内）。');
    }

    const current = await socialRepository.findPostById(context.connection, input.id);
    if (current === null) {
      throw new NotFoundError('SocialPost', input.id);
    }

    if (input.status !== undefined && !canTransition(current.status, input.status)) {
      // 起きた事実は書き換えない。
      throw new ValidationError(
        'SocialPost',
        'status',
        `${current.status} から ${input.status} へは変更できません。`,
      );
    }

    const post = await context.connection.transaction((tx) =>
      socialRepository.updatePost(tx, input.id, {
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.scheduledAt === undefined ? {} : { scheduledAt: input.scheduledAt }),
        ...(input.status === undefined ? {} : { status: input.status }),
        // published へ移すときだけ配信時刻を記録する。
        ...(input.status === 'published' ? { publishedAt: new Date() } : {}),
        // failed も同じ扱い。**updated_at で代用しない。**
        // あれは「最後に触った時刻」であって「失敗した時刻」ではない。
        ...(input.status === 'failed' ? { failedAt: new Date() } : {}),
        ...(input.failureReason === undefined
          ? {}
          : { failureReason: normalizeFailureReason(input.failureReason) }),
      }),
    );

    if (post === null) {
      throw new NotFoundError('SocialPost', input.id);
    }

    if (input.status === 'published') {
      await emit('social.post.published', { postId: post.id, accountId: post.socialAccountId });
    }

    return post;
  },
});

export const deleteSocialPost = defineUseCase<{ id: string }, void>({
  name: 'social.post.delete',
  permission: 'social.delete',
  audit: { action: 'deleted', resourceType: 'social_post', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      socialRepository.deletePost(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('SocialPost', input.id);
    }
  },
});
