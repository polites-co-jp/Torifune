import { describe, expect, it } from 'vitest';

/**
 * 順に投稿の純関数（055-social-pending-tab 設計 §9.5.2・057-social-bulk-post 設計 §5.4、受け入れ条件 055 #44・057 #21）。
 *
 * * 055 #44：`manualOutcomeRequestBody(outcome, expectedUpdatedAt, externalUrl)` は、`posted` で URL が空なら
 *   `externalUrl` を含まず、URL があれば（前後の空白を落として）含む。`not_posted` は含まない（057 で変えない）
 * * 057 #21：`windowStageAfter(state, event)` は設計 §5.4 の段の表のとおりに移る。状態は `{ stage, left }`
 *   （`left` は窓を開いた後に離れたか。実装プラン §8 の 12）、出来事は `open`・`left`・`back`・`recordNow`
 *
 * 055 #43（`manualSequencePlanOf`）の件は 057 で消した（関数は 057 の T11 で消え、振り分けは `bulkPostPlanOf`
 * ＝ `bulk-post-plan.test.ts` #13〜#17 が見る。057 設計 §14.1・実装プラン §8 の 6）。
 *
 * `ui/social/manual-sequence-plan.ts` は指定子を `string` の定数に置いた動的 import で読む（未実装の関数を型検査に掛けない）。
 */

interface ManualOutcomeBody {
  readonly outcome: 'posted' | 'not_posted';
  readonly expectedUpdatedAt: string;
  readonly externalUrl?: string;
}

type WindowStage = 'ready' | 'opened' | 'returned';
type WindowEvent = 'open' | 'left' | 'back' | 'recordNow';

interface WindowState {
  readonly stage: WindowStage;
  readonly left: boolean;
}

interface ManualSequencePlanModule {
  readonly manualOutcomeRequestBody: (
    outcome: 'posted' | 'not_posted',
    expectedUpdatedAt: string,
    externalUrl: string,
  ) => ManualOutcomeBody;
}

const MODULE: string = '@/ui/social/manual-sequence-plan';

async function load(): Promise<ManualSequencePlanModule> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Partial<ManualSequencePlanModule>;
  if (typeof module.manualOutcomeRequestBody !== 'function') {
    throw new Error('ui/social/manual-sequence-plan.ts に manualOutcomeRequestBody が無い');
  }
  return module as ManualSequencePlanModule;
}

async function loadWindowStageAfter(): Promise<
  (state: WindowState, event: WindowEvent) => WindowState
> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const fn = module['windowStageAfter'];
  if (typeof fn !== 'function') {
    throw new Error('ui/social/manual-sequence-plan.ts に windowStageAfter が無い');
  }
  return fn as (state: WindowState, event: WindowEvent) => WindowState;
}

// ---------------------------------------------------------------------------
// #44 manualOutcomeRequestBody
// ---------------------------------------------------------------------------

describe('#44 manualOutcomeRequestBody', () => {
  const UPDATED_AT = '2026-10-23T00:00:00.123Z';

  it('#44 posted で URL が空なら { outcome, expectedUpdatedAt }（externalUrl を含まない）', async () => {
    const { manualOutcomeRequestBody } = await load();

    const body = manualOutcomeRequestBody('posted', UPDATED_AT, '');

    expect(body).toEqual({ outcome: 'posted', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('externalUrl');
  });

  it('#44 posted で URL が空白だけなら externalUrl を含まない', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(Object.keys(manualOutcomeRequestBody('posted', UPDATED_AT, '   '))).not.toContain(
      'externalUrl',
    );
  });

  it('#44 posted で URL があれば externalUrl を含む', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(
      manualOutcomeRequestBody('posted', UPDATED_AT, 'https://x.com/torifune/status/1'),
    ).toEqual({
      outcome: 'posted',
      expectedUpdatedAt: UPDATED_AT,
      externalUrl: 'https://x.com/torifune/status/1',
    });
  });

  it('#44 posted の URL は前後の空白を落とす', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(
      manualOutcomeRequestBody('posted', UPDATED_AT, '  https://x.com/torifune/status/1 \n')
        .externalUrl,
    ).toBe('https://x.com/torifune/status/1');
  });

  it('#44 not_posted は URL を渡しても externalUrl を含まない', async () => {
    const { manualOutcomeRequestBody } = await load();

    const body = manualOutcomeRequestBody(
      'not_posted',
      UPDATED_AT,
      'https://x.com/torifune/status/1',
    );

    expect(body).toEqual({ outcome: 'not_posted', expectedUpdatedAt: UPDATED_AT });
    expect(Object.keys(body)).not.toContain('externalUrl');
  });

  it('#44 not_posted で URL が空でも { outcome, expectedUpdatedAt }', async () => {
    const { manualOutcomeRequestBody } = await load();

    expect(manualOutcomeRequestBody('not_posted', UPDATED_AT, '')).toEqual({
      outcome: 'not_posted',
      expectedUpdatedAt: UPDATED_AT,
    });
  });
});

// ---------------------------------------------------------------------------
// 057 #21 windowStageAfter
// ---------------------------------------------------------------------------

describe('057 #21 windowStageAfter（設計 §5.4 の段の表）', () => {
  const READY: WindowState = { stage: 'ready', left: false };
  const OPENED: WindowState = { stage: 'opened', left: false };
  const OPENED_LEFT: WindowState = { stage: 'opened', left: true };
  const RETURNED: WindowState = { stage: 'returned', left: true };

  describe('#21 open（開いた・リンクを押した）', () => {
    it.each([
      ['ready', READY],
      ['opened（離れていない）', OPENED],
      ['opened（離れた）', OPENED_LEFT],
      ['returned', RETURNED],
    ] as const)('#21 %s → opened（離れたかを数え直す）', async (_label, state) => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(state, 'open')).toEqual({ stage: 'opened', left: false });
    });
  });

  describe('#21 left（blur・hidden）', () => {
    it('#21 ready → 変えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(READY, 'left')).toEqual(READY);
    });

    it('#21 opened（離れていない）→ 離れた', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(OPENED, 'left')).toEqual(OPENED_LEFT);
    });

    it('#21 opened（離れた）→ 離れたまま', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(OPENED_LEFT, 'left')).toEqual(OPENED_LEFT);
    });

    it('#21 returned → 変えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(RETURNED, 'left')).toEqual(RETURNED);
    });
  });

  describe('#21 back（focus・visible）', () => {
    it('#21 ready → 変えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(READY, 'back')).toEqual(READY);
    });

    it('#21 opened（離れていない）→ 変えない（left の前の back では returned にならない）', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(OPENED, 'back')).toEqual(OPENED);
    });

    it('#21 opened（離れた）→ returned（left の後の back で戻った）', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(OPENED_LEFT, 'back').stage).toBe('returned');
    });

    it('#21 returned → 変えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(RETURNED, 'back')).toEqual(RETURNED);
    });
  });

  describe('#21 recordNow（「記録へ進む」）', () => {
    it.each([
      ['ready', READY],
      ['opened（離れていない）', OPENED],
      ['opened（離れた）', OPENED_LEFT],
    ] as const)('#21 %s → returned', async (_label, state) => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(state, 'recordNow').stage).toBe('returned');
    });

    it('#21 returned → 変えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();

      expect(windowStageAfter(RETURNED, 'recordNow')).toEqual(RETURNED);
    });
  });

  describe('#21 続けて起きる出来事', () => {
    it('#21 open → back（離れる前に戻る）→ left → back で returned', async () => {
      const windowStageAfter = await loadWindowStageAfter();
      let state: WindowState = READY;

      state = windowStageAfter(state, 'open');
      state = windowStageAfter(state, 'back');
      expect(state.stage).toBe('opened');
      state = windowStageAfter(state, 'left');
      state = windowStageAfter(state, 'back');
      expect(state.stage).toBe('returned');
    });

    it('#21 離れた後に開き直すと数え直し、その直後の back では戻らない', async () => {
      const windowStageAfter = await loadWindowStageAfter();
      let state: WindowState = READY;

      state = windowStageAfter(state, 'open');
      state = windowStageAfter(state, 'left');
      state = windowStageAfter(state, 'open');
      state = windowStageAfter(state, 'back');

      expect(state.stage).toBe('opened');
    });

    it('#21 渡した状態を書き換えない', async () => {
      const windowStageAfter = await loadWindowStageAfter();
      const state: WindowState = { stage: 'opened', left: false };

      windowStageAfter(state, 'left');

      expect(state).toEqual({ stage: 'opened', left: false });
    });
  });
});
