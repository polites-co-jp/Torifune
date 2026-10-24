'use client';

import {
  parsePostSourceParam,
  postSourceParamOf,
  type PostSourceFilter,
} from '@/domain/social/post-source';
import { FormField, Select } from '@/ui/components';
import {
  POST_FILTER_ACCOUNT_LABEL,
  POST_FILTER_ALL,
  POST_FILTER_CLEAR,
  POST_FILTER_PER_PAGE_LABEL,
  POST_FILTER_SOURCE_LABEL,
  POST_FILTER_STATUS_LABEL,
} from '@/ui/social/labels';
import { POST_PER_PAGE_OPTIONS, type PostListOption } from '@/ui/social/post-list-params';

/**
 * 投稿の絞り込みの帯（054-bulk-post-actions 設計 §9.2。055-social-pending-tab 設計 §9.4 で `social-posts.tsx` から切り出した）。
 *
 * 投稿タブと送信待ちタブが使う。条件はサーバで掛ける。選び直すと 1 ページ目からページ全体を読み込み直す
 * （URL は呼ぶ側の `hrefFor` が作る。投稿タブは `postListHref`、送信待ちタブは `pendingListHref`）。
 * 狭い画面では各 Select を幅いっぱいにして縦に折り返す（054 設計 §9.11）。
 */

/** 帯が読み書きする条件の項目（投稿タブ・送信待ちタブの条件に共通）。 */
export interface PostFilterBarFilters {
  readonly status: string | null;
  readonly accountId: string | null;
  readonly source: PostSourceFilter | null;
  readonly perPage: number;
  readonly page: number;
}

/** 状態の選択肢の外に足す `Select`（送信待ちタブの並び順。055 設計 §9.2）。 */
export interface PostFilterBarExtraSelect<F extends PostFilterBarFilters> {
  readonly label: string;
  readonly value: string;
  readonly options: readonly PostListOption[];
  /** 選んだ値を条件に写す（ページは帯が 1 に戻す）。 */
  readonly apply: (value: string) => Partial<F>;
}

export interface PostFilterBarProps<F extends PostFilterBarFilters> {
  readonly filters: F;
  /** 条件の URL。 */
  readonly hrefFor: (filters: F) => string;
  /** 状態の選択肢（先頭の「すべて」を含む。値 `''` が「すべて」）。 */
  readonly statusOptions: readonly PostListOption[];
  /** 状態の選択肢の値を条件に読む（知らない値は null）。 */
  readonly toStatus: (value: string) => F['status'];
  /** アカウントの絞り込みの選択肢（「すべて」を含めない。名前順）。 */
  readonly accountOptions?: readonly PostListOption[];
  /** 登録元の絞り込みの選択肢（「すべて」を含む。`postSourceOptionsOf` が作る）。 */
  readonly sourceOptions?: readonly PostListOption[];
  /** 表示件数の隣に置く `Select`（任意）。 */
  readonly extraSelect?: PostFilterBarExtraSelect<F>;
  /** 条件（状態・アカウント・登録元）があるか。あれば「条件をクリア」を出す。 */
  readonly hasConditions: boolean;
  /** 「条件をクリア」の行き先。 */
  readonly clearHref: string;
}

export function PostFilterBar<F extends PostFilterBarFilters>(props: PostFilterBarProps<F>) {
  const { filters } = props;

  /** 絞り込みを選び直す。1 ページ目からページ全体を読み込み直す（054 設計 §9.2）。 */
  function applyFilters(next: Partial<F>): void {
    window.location.assign(props.hrefFor({ ...filters, ...next, page: 1 } as F));
  }

  const sourceValue = filters.source === null ? '' : postSourceParamOf(filters.source);
  const sourceOptions = props.sourceOptions ?? [{ value: '', label: POST_FILTER_ALL }];
  const extra = props.extraSelect;

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 10rem), 1fr))',
        gap: '0 var(--tf-space-4)',
        alignItems: 'end',
      }}
    >
      <FormField label={POST_FILTER_STATUS_LABEL}>
        {(field) => (
          <Select
            {...field}
            value={filters.status ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              applyFilters({ status: props.toStatus(value) } as Partial<F>);
            }}
          >
            {props.statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={POST_FILTER_ACCOUNT_LABEL}>
        {(field) => (
          <Select
            {...field}
            value={filters.accountId ?? ''}
            onChange={(event) => {
              const value = event.currentTarget.value;
              applyFilters({ accountId: value === '' ? null : value } as Partial<F>);
            }}
          >
            <option value="">{POST_FILTER_ALL}</option>
            {(props.accountOptions ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={POST_FILTER_SOURCE_LABEL}>
        {(field) => (
          <Select
            {...field}
            value={sourceValue}
            onChange={(event) =>
              applyFilters({
                source: parsePostSourceParam(event.currentTarget.value),
              } as Partial<F>)
            }
          >
            {sourceOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      <FormField label={POST_FILTER_PER_PAGE_LABEL}>
        {(field) => (
          <Select
            {...field}
            value={String(filters.perPage)}
            onChange={(event) =>
              applyFilters({ perPage: Number(event.currentTarget.value) } as Partial<F>)
            }
          >
            {POST_PER_PAGE_OPTIONS.map((option) => (
              <option key={option} value={String(option)}>
                {option}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {extra !== undefined && (
        <FormField label={extra.label}>
          {(field) => (
            <Select
              {...field}
              value={extra.value}
              onChange={(event) => applyFilters(extra.apply(event.currentTarget.value))}
            >
              {extra.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
      )}
      {props.hasConditions && (
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <a href={props.clearHref}>{POST_FILTER_CLEAR}</a>
        </div>
      )}
    </div>
  );
}
