import { uuidv7 } from 'uuidv7';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import { NotFoundError, ValidationError } from '@/domain/repository';
import type { Secret } from '@/domain/secret';
import {
  canTransition,
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
      status: input.status,
    }),
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
}

export const updateSocialPost = defineUseCase<UpdatePostInput, SocialPost>({
  name: 'social.post.update',
  permission: 'social.write',
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
  handler: async (context, input) => {
    const deleted = await context.connection.transaction((tx) =>
      socialRepository.deletePost(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('SocialPost', input.id);
    }
  },
});
