import { uuidv7 } from 'uuidv7';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import { NotFoundError, ValidationError } from '@/domain/repository';
import {
  DEFAULT_LISTED_STATUSES,
  isValidSiteName,
  isValidSiteUrl,
  type Site,
  type SiteStatus,
} from '@/domain/site/site';
import type { SiteListQuery, SitePage } from '@/domain/site/site-repository';
import { siteRepository } from '@/infrastructure/site-repository';
import { siteEventPayload } from './site-events';

/**
 * Webサイトの UseCase。
 *
 * **認可は `defineUseCase` が行う**（決定事項 D-06）。
 * 各 UseCase は Permission を定義の一部として持つため、呼び忘れが起きない。
 *
 * トランザクション境界もここで張る。Repository や API Layer からは張らない。
 */

export interface ListSitesInput {
  readonly page: number;
  readonly perPage: number;
  readonly status: SiteStatus | null;
  readonly keyword: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export const listSites = defineUseCase<ListSitesInput, SitePage>({
  name: 'site.list',
  permission: 'site.read',
  handler: async (context, input) => {
    // 状態を指定しなければ archived を隠す。
    // 「もう使わないが記録は残す」ものが既定の一覧に混ざると、実運用で邪魔になる。
    const statuses: readonly SiteStatus[] =
      input.status === null ? DEFAULT_LISTED_STATUSES : [input.status];

    const query: SiteListQuery = {
      page: input.page,
      perPage: input.perPage,
      statuses,
      keyword: input.keyword,
      sort: input.sort,
    };

    return siteRepository.list(context.connection, query);
  },
});

export const getSite = defineUseCase<{ id: string }, Site>({
  name: 'site.get',
  permission: 'site.read',
  handler: async (context, input) => {
    const site = await siteRepository.findById(context.connection, input.id);
    if (site === null) {
      throw new NotFoundError('Site', input.id);
    }
    return site;
  },
});

export interface CreateSiteInput {
  readonly name: string;
  readonly url: string;
  readonly description: string;
  readonly status: SiteStatus;
}

export const createSite = defineUseCase<CreateSiteInput, Site>({
  name: 'site.create',
  permission: 'site.write',
  audit: {
    action: 'created',
    resourceType: 'site',
    resourceId: (_input, site) => site.id,
    detail: (_input, site) => ({ name: site.name, url: site.url }),
  },
  handler: async (context, input) => {
    assertValid(input.name, input.url);

    const identity = requireAuthenticated(context);

    const site = await context.connection.transaction((tx) =>
      siteRepository.insert(tx, {
        id: uuidv7(),
        name: input.name.trim(),
        url: input.url,
        description: input.description,
        status: input.status,
        createdBy: identity.userId,
      }),
    );

    // トランザクションの外で発火する。購読側の失敗で作成が取り消されないように。
    await emit('site.created', siteEventPayload(site));
    return site;
  },
});

export interface UpdateSiteInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly url?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: SiteStatus | undefined;
}

export const updateSite = defineUseCase<UpdateSiteInput, Site>({
  name: 'site.update',
  permission: 'site.write',
  audit: {
    action: 'updated',
    resourceType: 'site',
    resourceId: (input) => input.id,
    // 何を変えようとしたかを残す。値そのものは残さない（変更後は site 側で追える）。
    detail: (input) => ({
      changed: Object.keys(input).filter((key) => key !== 'id'),
    }),
  },
  handler: async (context, input) => {
    if (input.name !== undefined && !isValidSiteName(input.name)) {
      throw new ValidationError('Site', 'name', '名前を入力してください（200文字以内）。');
    }
    if (input.url !== undefined && !isValidSiteUrl(input.url)) {
      throw new ValidationError(
        'Site',
        'url',
        'http:// または https:// で始まるURLを入力してください。',
      );
    }

    const site = await context.connection.transaction((tx) =>
      siteRepository.update(tx, input.id, {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
      }),
    );

    if (site === null) {
      throw new NotFoundError('Site', input.id);
    }

    await emit('site.updated', siteEventPayload(site));
    return site;
  },
});

export const deleteSite = defineUseCase<{ id: string }, void>({
  name: 'site.delete',
  permission: 'site.delete',
  // 消えたあとで何が消えたかを追えなければ、監査にならない。
  audit: { action: 'deleted', resourceType: 'site', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const site = await siteRepository.findById(context.connection, input.id);
    if (site === null) {
      throw new NotFoundError('Site', input.id);
    }

    const deleted = await context.connection.transaction((tx) =>
      siteRepository.delete(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('Site', input.id);
    }

    await emit('site.deleted', siteEventPayload(site));
  },
});

/**
 * 入力の検証。
 *
 * API Layer の Zod でも検証しているが、**UseCase を直接呼ぶ経路がある**ため
 * （Server Component、Plugin の Data API）、ここでも確かめる。
 */
function assertValid(name: string, url: string): void {
  if (!isValidSiteName(name)) {
    throw new ValidationError('Site', 'name', '名前を入力してください（200文字以内）。');
  }
  if (!isValidSiteUrl(url)) {
    throw new ValidationError(
      'Site',
      'url',
      'http:// または https:// で始まるURLを入力してください。',
    );
  }
}
