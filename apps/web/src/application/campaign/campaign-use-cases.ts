import type { CampaignEventPayload } from '@torifune/plugin-api';
import { uuidv7 } from 'uuidv7';
import { requireAuthenticated } from '@/application/authorization/authorize';
import { defineUseCase } from '@/application/authorization/use-case';
import { emit } from '@/application/events';
import { assertUsableText } from '@/application/text-input';
import {
  DEFAULT_LISTED_CAMPAIGN_STATUSES,
  isCampaignStatus,
  isValidCampaignName,
  isValidDateOnly,
  isValidPeriod,
  normalizeCampaignLinkIds,
  type Campaign,
  type CampaignStatus,
} from '@/domain/campaign/campaign';
import type {
  CampaignLinks,
  CampaignListQuery,
  CampaignPage,
} from '@/domain/campaign/campaign-repository';
import type { Connection } from '@/database/provider';
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
    assertUsableText('Campaign', { keyword: input.keyword });

    // 形（YYYY-MM-DD）は API の Zod が見る。暦に無い日付（2026-02-30 など）は DB の ::date まで届くと
    // 例外（500）になるので、ここで断る（045-campaign-input-500 設計 §6.2）。
    if (input.activeOn !== null && !isValidDateOnly(input.activeOn)) {
      throw new ValidationError('Campaign', 'activeOn', '存在しない日付です。');
    }

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
    assertUsableText('Campaign', { name: input.name, description: input.description });
    assertValid(input.name, input.startsOn, input.endsOn);
    assertValidStatus(input.status);
    const links = normalizeLinks({
      siteIds: input.siteIds,
      // 省略（undefined）だけが「紐づけない」。null は配列でない値として断る（設計 §9.2）。
      socialPostIds: input.socialPostIds === undefined ? [] : input.socialPostIds,
    });

    const identity = requireAuthenticated(context);

    const campaign = await context.connection.transaction(async (tx) => {
      await assertLinksExist(tx, links);
      return campaignRepository.insert(tx, {
        id: uuidv7(),
        name: input.name.trim(),
        description: input.description,
        status: input.status,
        startsOn: input.startsOn,
        endsOn: input.endsOn,
        siteIds: links.siteIds ?? [],
        socialPostIds: links.socialPostIds ?? [],
        createdBy: identity.userId,
      });
    });

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
    assertUsableText('Campaign', { name: input.name, description: input.description });
    if (input.name !== undefined && !isValidCampaignName(input.name)) {
      throw new ValidationError('Campaign', 'name', '名前を入力してください（200文字以内）。');
    }
    if (input.status !== undefined) {
      assertValidStatus(input.status);
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

    // 指定したものだけを検査する。省略は「変えない」。
    const links = normalizeLinks({
      ...(input.siteIds === undefined ? {} : { siteIds: input.siteIds }),
      ...(input.socialPostIds === undefined ? {} : { socialPostIds: input.socialPostIds }),
    });

    const campaign = await context.connection.transaction(async (tx) => {
      if (links.siteIds !== undefined || links.socialPostIds !== undefined) {
        // キャンペーンの行を先に押さえ、存在しなければ 404 を先に返す（紐づけ先の存在より前。
        // 045 設計 §6.3 の検査の順序）。行を先に押さえるので、同じキャンペーンへの更新の順番待ちの間は
        // 紐づけ先を押さえない（サイト・投稿の削除を待たせない。§6.4）。
        if (!(await campaignRepository.lockForUpdate(tx, input.id))) {
          throw new NotFoundError('Campaign', input.id);
        }
        await assertLinksExist(tx, links);
      }
      return campaignRepository.update(tx, input.id, {
        ...(input.name === undefined ? {} : { name: input.name.trim() }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.startsOn === undefined ? {} : { startsOn: input.startsOn }),
        ...(input.endsOn === undefined ? {} : { endsOn: input.endsOn }),
        ...(links.siteIds === undefined ? {} : { siteIds: links.siteIds }),
        ...(links.socialPostIds === undefined ? {} : { socialPostIds: links.socialPostIds }),
      });
    });

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

/** 指定された紐づけ先（省略したものは `undefined` のまま）。 */
interface LinkInput {
  readonly siteIds?: unknown;
  readonly socialPostIds?: unknown;
}

/** 検査・正規化した紐づけ先。指定されなかったものは `undefined`。 */
interface NormalizedLinks {
  readonly siteIds?: readonly string[];
  readonly socialPostIds?: readonly string[];
}

const LINK_FIELDS = ['siteIds', 'socialPostIds'] as const;
type LinkField = (typeof LINK_FIELDS)[number];

const LINK_REASON_MESSAGES = {
  shape: 'UUID の形で指定してください。',
  tooMany: '1000件以内で指定してください。',
} as const;

const LINK_NOT_FOUND_MESSAGES: Readonly<Record<LinkField, string>> = {
  siteIds: '存在しないWebサイトが含まれています。',
  socialPostIds: '存在しないSNS投稿が含まれています。',
};

/**
 * 紐づけ先の形と件数を検査し、小文字・重複なし・昇順にそろえる（045-campaign-input-500 設計 §6.3）。
 *
 * API の Zod は件数の上限しか見ない。**UseCase を直接呼ぶ経路（Data API）がある**ため、
 * 配列であること・要素の形もここで確かめる。DB は読まない。
 * 両方に誤りがあれば `details` にまとめる。**送った値は載せない。**
 */
function normalizeLinks(input: LinkInput): NormalizedLinks {
  const normalized: { siteIds?: readonly string[]; socialPostIds?: readonly string[] } = {};
  const errors: Partial<Record<LinkField, readonly string[]>> = {};

  for (const field of LINK_FIELDS) {
    if (input[field] === undefined) {
      continue;
    }
    const result = normalizeCampaignLinkIds(input[field]);
    if (result.ok) {
      normalized[field] = result.ids;
    } else {
      errors[field] = [LINK_REASON_MESSAGES[result.reason]];
    }
  }

  throwLinkErrors(errors);
  return normalized;
}

/**
 * 紐づけ先がすべて存在することを確かめ、その行を押さえる（045-campaign-input-500 設計 §6.4）。
 *
 * **書き込みと同じトランザクションの中で呼ぶ。** 押さえた行は書き込みが終わるまで消されないので、
 * 確かめた後に消されて外部キー違反（500）になることが無い。
 */
async function assertLinksExist(tx: Connection, links: NormalizedLinks): Promise<void> {
  const wanted: CampaignLinks = {
    siteIds: links.siteIds ?? [],
    socialPostIds: links.socialPostIds ?? [],
  };
  const found = await campaignRepository.lockExistingLinks(tx, wanted);

  const errors: Partial<Record<LinkField, readonly string[]>> = {};
  for (const field of LINK_FIELDS) {
    const existing = new Set(found[field]);
    if (wanted[field].some((id) => !existing.has(id))) {
      errors[field] = [LINK_NOT_FOUND_MESSAGES[field]];
    }
  }

  throwLinkErrors(errors);
}

/** 誤りが 1 つでもあれば `ValidationError`。`field` / `detail` は先頭の 1 件、`details` に全部。 */
function throwLinkErrors(errors: Partial<Record<LinkField, readonly string[]>>): void {
  const first = LINK_FIELDS.find((field) => errors[field] !== undefined);
  if (first === undefined) {
    return;
  }
  throw new ValidationError(
    'Campaign',
    first,
    (errors[first] ?? [])[0] ?? '',
    errors as Readonly<Record<string, readonly string[]>>,
  );
}

/**
 * 状態が列挙の値か（046-input-500-nul-and-ranges 設計 §9.2 の N1）。
 *
 * HTTP は Zod の `enum` が断るが、Data API（Plugin）は型だけで値を確かめずに渡しうる。
 * 見なければ CHECK 制約の `DatabaseError` になる。
 */
function assertValidStatus(status: string): void {
  if (!isCampaignStatus(status)) {
    throw new ValidationError('Campaign', 'status', '状態の値が正しくありません。');
  }
}
