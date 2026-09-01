import type { CampaignEventPayload } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import {
  DEFAULT_LISTED_CAMPAIGN_STATUSES,
  isValidCampaignName,
  isValidPeriod,
  type Campaign,
  type CampaignStatus,
} from '@/domain/campaign/campaign';
import type { CampaignListQuery, CampaignPage } from '@/domain/campaign/campaign-repository';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { campaignRepository } from '@/infrastructure/campaign-repository';

/**
 * キャンペーン（017-campaigns）。
 *
 * **認可は `defineUseCase` が行う**（決定事項 D-06）。
 * `site-use-cases.ts` と同じ形にそろえている。
 */

function payloadOf(campaign: Campaign): CampaignEventPayload {
  return {
    campaignId: campaign.id,
    name: campaign.name,
    status: campaign.status,
    startsOn: campaign.startsOn,
    endsOn: campaign.endsOn,
    siteIds: campaign.siteIds,
    socialPostIds: campaign.socialPostIds,
  };
}

export interface ListCampaignsInput {
  readonly page: number;
  readonly perPage: number;
  readonly status: CampaignStatus | null;
  readonly keyword: string | null;
  readonly activeOn: string | null;
  readonly siteId: string | null;
  readonly sort: readonly { field: string; direction: 'asc' | 'desc' }[];
}

export const listCampaigns = defineUseCase<ListCampaignsInput, CampaignPage>({
  name: 'campaign.list',
  permission: 'campaign.read',
  handler: async (context, input) => {
    // 状態を指定しなければ cancelled を隠す。
    // 「やらなかった記録」が既定の一覧に混ざると邪魔になる。
    const statuses: readonly CampaignStatus[] =
      input.status === null ? DEFAULT_LISTED_CAMPAIGN_STATUSES : [input.status];

    const query: CampaignListQuery = {
      page: input.page,
      perPage: input.perPage,
      statuses,
      keyword: input.keyword,
      activeOn: input.activeOn,
      siteId: input.siteId,
      sort: input.sort,
    };

    return campaignRepository.list(context.connection, query);
  },
});

export const getCampaign = defineUseCase<{ id: string }, Campaign>({
  name: 'campaign.get',
  permission: 'campaign.read',
  handler: async (context, input) => {
    const campaign = await campaignRepository.findById(context.connection, input.id);
    if (campaign === null) {
      throw new NotFoundError('Campaign', input.id);
    }
    return campaign;
  },
});

export interface CreateCampaignInput {
  readonly name: string;
  readonly description: string;
  readonly status: CampaignStatus;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly siteIds: readonly string[];
  /**
   * 紐づくSNS投稿。
   *
   * **任意にしてある。** 必須にすると、既存の呼び出し（API・Data API・
   * Server Component）がすべて型エラーになる。省略は「紐づけない」。
   */
  readonly socialPostIds?: readonly string[] | undefined;
}

export const createCampaign = defineUseCase<CreateCampaignInput, Campaign>({
  name: 'campaign.create',
  permission: 'campaign.write',
  audit: {
    action: 'created',
    resourceType: 'campaign',
    resourceId: (_input, campaign) => campaign.id,
    detail: (_input, campaign) => ({ name: campaign.name, status: campaign.status }),
  },
  handler: async (context, input) => {
    assertValid(input.name, input.startsOn, input.endsOn);

    const identity = requireAuthenticated(context);

    const campaign = await context.connection.transaction((tx) =>
      campaignRepository.insert(tx, {
        id: uuidv7(),
        name: input.name.trim(),
        description: input.description,
        status: input.status,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        siteIds: input.siteIds,
        socialPostIds: input.socialPostIds ?? [],
        createdBy: identity.userId,
      }),
    );

    // トランザクションの外で発火する。購読側の失敗で作成が取り消されないように。
    await emit('campaign.created', payloadOf(campaign));
    return campaign;
  },
});

export interface UpdateCampaignInput {
  readonly id: string;
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly status?: CampaignStatus | undefined;
  readonly startsOn?: string | undefined;
  readonly endsOn?: string | null | undefined;
  readonly siteIds?: readonly string[] | undefined;
  /** 指定したら丸ごと置き換える。指定しなければ触らない。 */
  readonly socialPostIds?: readonly string[] | undefined;
}

export const updateCampaign = defineUseCase<UpdateCampaignInput, Campaign>({
  name: 'campaign.update',
  permission: 'campaign.write',
  audit: {
    action: 'updated',
    resourceType: 'campaign',
    resourceId: (input) => input.id,
    detail: (input) => ({ changed: Object.keys(input).filter((key) => key !== 'id') }),
  },
  handler: async (context, input) => {
    if (input.name !== undefined && !isValidCampaignName(input.name)) {
      throw new ValidationError('Campaign', 'name', '名前を入力してください（200文字以内）。');
    }

    // **期間は片方だけ変えられる。** いまの値と突き合わせないと逆転を見逃す。
    if (input.startsOn !== undefined || input.endsOn !== undefined) {
      const current = await campaignRepository.findById(context.connection, input.id);
      if (current === null) {
        throw new NotFoundError('Campaign', input.id);
      }
      const startsOn = input.startsOn ?? current.startsOn;
      const endsOn = input.endsOn === undefined ? current.endsOn : input.endsOn;
      assertPeriod(startsOn, endsOn);
    }

    const campaign = await context.connection.transaction((tx) =>
      campaignRepository.update(tx, input.id, {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsOn === undefined ? {} : { startsOn: input.startsOn }),
        ...(input.endsOn === undefined ? {} : { endsOn: input.endsOn }),
        ...(input.siteIds === undefined ? {} : { siteIds: input.siteIds }),
        ...(input.socialPostIds === undefined ? {} : { socialPostIds: input.socialPostIds }),
      }),
    );

    if (campaign === null) {
      throw new NotFoundError('Campaign', input.id);
    }

    await emit('campaign.updated', payloadOf(campaign));
    return campaign;
  },
});

export const deleteCampaign = defineUseCase<{ id: string }, void>({
  name: 'campaign.delete',
  permission: 'campaign.delete',
  audit: { action: 'deleted', resourceType: 'campaign', resourceId: (input) => input.id },
  handler: async (context, input) => {
    const campaign = await campaignRepository.findById(context.connection, input.id);
    if (campaign === null) {
      throw new NotFoundError('Campaign', input.id);
    }

    const deleted = await context.connection.transaction((tx) =>
      campaignRepository.delete(tx, input.id),
    );
    if (!deleted) {
      throw new NotFoundError('Campaign', input.id);
    }

    await emit('campaign.deleted', payloadOf(campaign));
  },
});

/**
 * 入力の検証。
 *
 * API Layer の Zod でも検証しているが、**UseCase を直接呼ぶ経路がある**ため
 * （Server Component、Plugin の Data API）、ここでも確かめる。
 */
function assertValid(name: string, startsOn: string, endsOn: string | null): void {
  if (!isValidCampaignName(name)) {
    throw new ValidationError('Campaign', 'name', '名前を入力してください（200文字以内）。');
  }
  assertPeriod(startsOn, endsOn);
}

function assertPeriod(startsOn: string, endsOn: string | null): void {
  if (!isValidPeriod(startsOn, endsOn)) {
    throw new ValidationError(
      'Campaign',
      'endsOn',
      '期間を確認してください（終了日は開始日以降にしてください）。',
    );
  }
}
