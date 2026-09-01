import {
  PluginPermissionError,
  type PluginDataApi,
  type CampaignView,
  type SiteView,
  type SocialPostView,
  type UserView,
} from '@torifune/plugin-api';
import type { AuthorizationContext } from '@/application/authorization/authorize';
import {
  createCampaign,
  deleteCampaign,
  getCampaign,
  listCampaigns,
  updateCampaign,
} from '@/application/campaign/campaign-use-cases';
import { listAnalytics, recordAnalytics } from '@/application/analytics/analytics-use-cases';
import {
  createSite,
  deleteSite,
  getSite,
  listSites,
  updateSite,
} from '@/application/site/site-use-cases';
import {
  getSocialAccount,
  getSocialPost,
  listSocialAccounts,
  listSocialPosts,
  updateSocialPost,
} from '@/application/social/social-use-cases';
import { getUser, listUsers } from '@/application/user/user-use-cases';
import { NotFoundError } from '@/domain/repository';
import type { Campaign } from '@/domain/campaign/campaign';
import type { Site } from '@/domain/site/site';
import type { SocialPost } from '@/domain/social/social';
import type { User } from '@/domain/user';

/**
 * Plugin 向け Data API の実装。
 *
 * **Plugin が Manifest で宣言した Permission を通る。**
 * 宣言していない操作は `PluginPermissionError` になる。
 * 「Plugin は信頼されたコード」だが、必要以上の権限を取得しない設計を目指す
 * （03_プラグイン設計.md §21）。
 *
 * さらに、**呼び出しは UseCase を経由する**。UseCase 側の認可も併せて働く。
 * Plugin が宣言していても、操作しているユーザーが権限を持たなければ通らない。
 */

export interface PluginDataApiDeps {
  readonly pluginId: string;
  /** Manifest で宣言された Permission。 */
  readonly declaredPermissions: ReadonlySet<string>;
  /** 実行時の認可文脈。 */
  readonly context: AuthorizationContext;
}

function toSiteView(site: Site): SiteView {
  return {
    id: site.id,
    name: site.name,
    url: site.url,
    description: site.description,
    status: site.status,
    createdAt: site.createdAt.toISOString(),
    updatedAt: site.updatedAt.toISOString(),
  };
}

/**
 * Plugin から見えるユーザー。
 *
 * **メールアドレスを出さない。** 表示に要らず、出せば漏洩の面が増える。
 * passwordHash は UserView の型に無いので、渡しようがない。
 */
function toUserView(user: User): UserView {
  return {
    id: user.id,
    loginId: user.loginId,
    displayName: user.displayName,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}

function toCampaignView(campaign: Campaign): CampaignView {
  return {
    id: campaign.id,
    name: campaign.name,
    description: campaign.description,
    status: campaign.status,
    startsOn: campaign.startsOn,
    endsOn: campaign.endsOn,
    siteIds: campaign.siteIds,
    socialPostIds: campaign.socialPostIds,
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}

/**
 * Plugin から見えるSNS投稿。
 *
 * **4箇所で同じ変換を書いていたのをまとめた。** 項目を足すたびに
 * 書き忘れる箇所が出る（実際 `failureReason` がどこにも出ていなかった）。
 */
function toSocialPostView(post: SocialPost): SocialPostView {
  return {
    id: post.id,
    socialAccountId: post.socialAccountId,
    body: post.body,
    scheduledAt: post.scheduledAt?.toISOString() ?? null,
    status: post.status,
    publishedAt: post.publishedAt?.toISOString() ?? null,
    failureReason: post.failureReason,
  };
}

const DEFAULT_PER_PAGE = 20;

export function createPluginDataApi(deps: PluginDataApiDeps): PluginDataApi {
  const { pluginId, declaredPermissions, context } = deps;

  /** Plugin が宣言していない Permission の操作を止める。 */
  function requireDeclared(permission: string): void {
    if (!declaredPermissions.has(permission)) {
      throw new PluginPermissionError(pluginId, permission);
    }
  }

  return {
    sites: {
      async list(options) {
        requireDeclared('site.read');
        const page = options?.page ?? 1;
        const perPage = options?.perPage ?? DEFAULT_PER_PAGE;

        const result = await listSites(context, {
          page,
          perPage,
          status: null,
          keyword: null,
          sort: [{ field: 'created_at', direction: 'desc' }],
        });

        return { items: result.items.map(toSiteView), total: result.total, page, perPage };
      },

      async get(id) {
        requireDeclared('site.read');
        try {
          return toSiteView(await getSite(context, { id }));
        } catch (error) {
          // Plugin へは「無い」を返す。存在の有無を例外で区別させない。
          if (error instanceof NotFoundError) {
            return null;
          }
          throw error;
        }
      },

      async create(input) {
        requireDeclared('site.write');
        const site = await createSite(context, {
          name: input.name,
          url: input.url,
          description: input.description ?? '',
          status: (input.status ?? 'active') as Site['status'],
        });
        return toSiteView(site);
      },

      async update(id, input) {
        requireDeclared('site.write');
        const site = await updateSite(context, {
          id,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status as Site['status'] }),
        });
        return toSiteView(site);
      },

      async delete(id) {
        requireDeclared('site.delete');
        await deleteSite(context, { id });
      },
    },

    campaigns: {
      async list(options) {
        requireDeclared('campaign.read');
        const page = options?.page ?? 1;
        const perPage = options?.perPage ?? DEFAULT_PER_PAGE;

        const result = await listCampaigns(context, {
          page,
          perPage,
          status: null,
          keyword: null,
          activeOn: null,
          siteId: options?.siteId ?? null,
          sort: [{ field: 'starts_on', direction: 'desc' }],
        });

        return { items: result.items.map(toCampaignView), total: result.total, page, perPage };
      },

      async get(id) {
        requireDeclared('campaign.read');
        try {
          return toCampaignView(await getCampaign(context, { id }));
        } catch (error) {
          if (error instanceof NotFoundError) {
            return null;
          }
          throw error;
        }
      },

      async create(input) {
        requireDeclared('campaign.write');
        const campaign = await createCampaign(context, {
          name: input.name,
          description: input.description ?? '',
          status: (input.status ?? 'draft') as Campaign['status'],
          startsOn: input.startsOn,
          endsOn: input.endsOn ?? null,
          siteIds: input.siteIds ?? [],
          socialPostIds: input.socialPostIds ?? [],
        });
        return toCampaignView(campaign);
      },

      async update(id, input) {
        requireDeclared('campaign.write');
        const campaign = await updateCampaign(context, {
          id,
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.status === undefined ? {} : { status: input.status as Campaign['status'] }),
          ...(input.startsOn === undefined ? {} : { startsOn: input.startsOn }),
          ...(input.endsOn === undefined ? {} : { endsOn: input.endsOn }),
          ...(input.siteIds === undefined ? {} : { siteIds: input.siteIds }),
          ...(input.socialPostIds === undefined ? {} : { socialPostIds: input.socialPostIds }),
        });
        return toCampaignView(campaign);
      },

      async delete(id) {
        requireDeclared('campaign.delete');
        await deleteCampaign(context, { id });
      },
    },

    analytics: {
      async list(query) {
        requireDeclared('analytics.read');
        return listAnalytics(context, {
          siteId: query.siteId ?? null,
          from: query.from,
          to: query.to,
          source: query.source ?? null,
        });
      },

      async record(point) {
        requireDeclared('analytics.read');
        // **出所は Plugin ID に固定する。** Plugin に名乗らせると、
        // 外部から取り込んだ値を本体の集計として表示させられる。
        await recordAnalytics(context, {
          siteId: point.siteId,
          metricDate: point.metricDate,
          source: pluginId,
          metric: point.metric,
          value: point.value,
        });
      },
    },

    socialAccounts: {
      async list(options) {
        requireDeclared('social.read');
        const page = options?.page ?? 1;
        const perPage = options?.perPage ?? DEFAULT_PER_PAGE;

        const result = await listSocialAccounts(context, { page, perPage, provider: null });

        return {
          items: result.items.map((account) => ({
            id: account.id,
            provider: account.provider,
            displayName: account.displayName,
            handle: account.handle,
            status: account.status,
            // **平文は渡さない。** Plugin は自分の資格情報を store で管理する。
            credentialConfigured: account.credentialConfigured,
          })),
          total: result.total,
          page,
          perPage,
        };
      },

      async get(id) {
        requireDeclared('social.read');
        try {
          const account = await getSocialAccount(context, { id });
          return {
            id: account.id,
            provider: account.provider,
            displayName: account.displayName,
            handle: account.handle,
            status: account.status,
            credentialConfigured: account.credentialConfigured,
          };
        } catch (error) {
          if (error instanceof NotFoundError) {
            return null;
          }
          throw error;
        }
      },
    },

    socialPosts: {
      async list(options) {
        requireDeclared('social.read');
        const page = options?.page ?? 1;
        const perPage = options?.perPage ?? DEFAULT_PER_PAGE;

        const result = await listSocialPosts(context, {
          page,
          perPage,
          socialAccountId: options?.accountId ?? null,
          status: null,
        });

        return {
          items: result.items.map(toSocialPostView),
          total: result.total,
          page,
          perPage,
        };
      },

      async get(id) {
        requireDeclared('social.read');
        try {
          return toSocialPostView(await getSocialPost(context, { id }));
        } catch (error) {
          if (error instanceof NotFoundError) {
            return null;
          }
          throw error;
        }
      },

      async markPublished(id) {
        requireDeclared('social.write');
        return toSocialPostView(await updateSocialPost(context, { id, status: 'published' }));
      },

      async markFailed(id, reason) {
        requireDeclared('social.write');
        // **理由を捨てない。** 以前はここが `reason` を渡しておらず、
        // 公開 API が受け取ると宣言している値がどこにも保存されていなかった。
        // 画面には「失敗」とだけ出て、理由が分からない状態だった。
        return toSocialPostView(
          await updateSocialPost(context, { id, status: 'failed', failureReason: reason }),
        );
      },
    },

    /**
     * ユーザー（05_API設計.md §22）。
     *
     * **読み取りだけ。** 作成・更新・削除の口を出さない。
     * 出すと、Plugin の導入がそのまま管理者の追加になりうる。
     */
    users: {
      async list(options) {
        requireDeclared('user.manage');
        const page = options?.page ?? 1;
        const perPage = options?.perPage ?? DEFAULT_PER_PAGE;

        const result = await listUsers(context, {
          page,
          perPage,
          status: null,
          keyword: null,
          sort: [{ field: 'created_at', direction: 'desc' }],
        });

        return {
          items: result.items.map((entry) => toUserView(entry.user)),
          total: result.total,
          page,
          perPage,
        };
      },

      async get(id) {
        requireDeclared('user.manage');
        try {
          const entry = await getUser(context, { id });
          return toUserView(entry.user);
        } catch (error) {
          if (error instanceof NotFoundError) {
            return null;
          }
          throw error;
        }
      },
    },
  };
}
