import { describe, expect, it } from 'vitest';
import { ForbiddenError } from '@/application/authorization/authorize';
import { NotFoundError, ValidationError } from '@/domain/repository';
import { SocialPostIneligibleError } from '@/domain/social/social';

/**
 * 行ごとの `handoff` の解決の読み替え `settleManualHandoff`（055-social-pending-tab 設計 §8.3・§9.12、
 * 受け入れ条件 #82 の単体（A）。検証 1 回目 security S1）。
 *
 * * 結果（`ok: true` / 既存の理由の `ok: false`）はそのまま返す
 * * `ValidationError`（とその派生）・`NotFoundError` は `{ ok: false, reason: 'changed' }`
 * * それ以外の例外（`ForbiddenError`・ただの `Error`）は同じ例外で reject する（認可の失敗・DB の障害を隠さない）
 *
 * `application/social/manual-handoff-settle.ts` はまだ無いので、指定子を `string` の定数に置いた動的 import で読む
 * （054 実装プラン §8 の 43）。型は設計 §8.3 から写す。
 */

type ManualHandoffOutcome =
  | { readonly ok: true; readonly url: string; readonly note: string | null }
  | {
      readonly ok: false;
      readonly reason: 'unsupported' | 'invalid_url' | 'plugin_error' | 'not_scheduled' | 'changed';
    };

type Settle = (pending: Promise<ManualHandoffOutcome>) => Promise<ManualHandoffOutcome>;

const MODULE: string = '@/application/social/manual-handoff-settle';

/**
 * 読み込んでから `pending` を作って渡す（先に reject した Promise を作ると、動的 import を待つ間に
 * 「拾われていない reject」になる）。
 */
async function settleManualHandoff(
  pending: () => Promise<ManualHandoffOutcome>,
): Promise<ManualHandoffOutcome> {
  const module = (await import(/* @vite-ignore */ MODULE)) as { settleManualHandoff?: Settle };
  if (typeof module.settleManualHandoff !== 'function') {
    throw new Error('application/social/manual-handoff-settle.ts に settleManualHandoff が無い');
  }
  return module.settleManualHandoff(pending());
}

const CHANGED = { ok: false, reason: 'changed' } as const;

describe('#82 settleManualHandoff：結果はそのまま返す', () => {
  it('#82 { ok: true, url, note } はそのまま', async () => {
    const outcome = { ok: true, url: 'https://example.com/intent', note: '補足' } as const;

    await expect(settleManualHandoff(() => Promise.resolve(outcome))).resolves.toEqual(outcome);
  });

  it.each(['unsupported', 'invalid_url', 'plugin_error', 'not_scheduled'] as const)(
    '#82 { ok: false, reason: %s } はそのまま（changed に替えない）',
    async (reason) => {
      await expect(
        settleManualHandoff(() => Promise.resolve({ ok: false, reason })),
      ).resolves.toEqual({
        ok: false,
        reason,
      });
    },
  );
});

describe('#82 settleManualHandoff：行が変わった例外は changed に読み替える', () => {
  it('#82 ValidationError（配信方法が自動へ変わった）→ { ok: false, reason: changed }', async () => {
    const error = new ValidationError('SocialPost', 'deliveryMode', '手動投稿ではありません。');

    await expect(settleManualHandoff(() => Promise.reject(error))).resolves.toEqual(CHANGED);
  });

  it('#82 ValidationError の派生（SocialPostIneligibleError）→ changed', async () => {
    const error = new SocialPostIneligibleError('not_applicable', '手動投稿の予約ではありません。');

    await expect(settleManualHandoff(() => Promise.reject(error))).resolves.toEqual(CHANGED);
  });

  it('#82 NotFoundError（行が消された）→ changed', async () => {
    const error = new NotFoundError('SocialPost', '01900000-0000-7000-8000-000000008200');

    await expect(settleManualHandoff(() => Promise.reject(error))).resolves.toEqual(CHANGED);
  });

  it('#82 NotFoundError（アカウントが消された）→ changed', async () => {
    const error = new NotFoundError('SocialAccount', '01900000-0000-7000-8000-000000008201');

    await expect(settleManualHandoff(() => Promise.reject(error))).resolves.toEqual(CHANGED);
  });
});

describe('#82 settleManualHandoff：それ以外の例外は投げ直す', () => {
  it('#82 ForbiddenError は同じ例外で reject（認可の失敗を開けない行に隠さない）', async () => {
    const error = new ForbiddenError();

    await expect(settleManualHandoff(() => Promise.reject(error))).rejects.toBe(error);
  });

  it('#82 ただの Error（DB の障害など）は同じ例外で reject', async () => {
    const error = new Error('connection terminated');

    await expect(settleManualHandoff(() => Promise.reject(error))).rejects.toBe(error);
  });
});
