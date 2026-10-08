import { describe, expect, it } from 'vitest';

/**
 * 同梱 Plugin の判定表（050-bundled-plugin-sync 設計 §6.3、受け入れ条件 #7〜#16）。
 *
 * 判定は**純関数**（Volume と写しの観測値 → 処理）。上から順に最初に当たった行の処理をする。
 * `H` = Volume のフォルダの木のハッシュ、`I` = 同梱の写しの木のハッシュ、`M` = 有効な印の `hash`。
 *
 * 観測（`plugin.json` の読み出し・印の解釈）は適用の側の責務なので、ここでは観測値を直に渡す。
 * `plugin.json` が「無い・JSON でない・`version` が文字列でない」がすべて `version: null` に
 * なることは `sync-bundled.test.ts` の「判定の観測」で見る（実装プラン §8 の 3）。
 *
 * **モジュールはまだ無い**（実装プラン T1。T3 で `sync-bundled.ts` に足す）。型検査を通すため、
 * 指定子を変数にした動的 import で読み、実装プラン §2「モジュールの形」の型を当てる。
 */

type VolumeState =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'present';
      readonly quarantined: boolean;
      readonly hash: string;
      readonly markerHash: string | null;
      readonly version: string | null;
    };

type BundledDecision =
  | { readonly result: 'restored' }
  | { readonly result: 'unchanged' }
  | { readonly result: 'adopted' }
  | { readonly result: 'updated'; readonly backup: boolean }
  | {
      readonly result: 'skipped';
      readonly reason: 'quarantined' | 'modified' | 'unreadable manifest';
    }
  | {
      readonly result: 'skipped';
      readonly reason: 'newer version';
      readonly installedVersion: string;
    };

interface DecisionModule {
  parseMarker(raw: string): string | null;
  decideBundled(input: {
    readonly bundledHash: string;
    readonly bundledVersion: string;
    readonly volume: VolumeState;
  }): BundledDecision;
  decideUnbundled(markerHash: string | null): 'kept' | 'untouched';
}

const SYNC_MODULE = './sync-bundled.js';
let syncModule: Promise<DecisionModule> | undefined;

function loadDecision(): Promise<DecisionModule> {
  syncModule ??= import(/* @vite-ignore */ SYNC_MODULE) as Promise<DecisionModule>;
  return syncModule;
}

/** 同梱の写しの木のハッシュ */
const I = `sha256:${'a'.repeat(64)}`;
/** I と違う 2 つのハッシュ */
const X = `sha256:${'b'.repeat(64)}`;
const Y = `sha256:${'c'.repeat(64)}`;

function present(volume: {
  readonly hash: string;
  readonly markerHash?: string | null;
  readonly version?: string | null;
  readonly quarantined?: boolean;
}): VolumeState {
  return {
    kind: 'present',
    quarantined: volume.quarantined ?? false,
    hash: volume.hash,
    markerHash: volume.markerHash ?? null,
    version: volume.version === undefined ? '1.0.0' : volume.version,
  };
}

async function decide(volume: VolumeState, bundledVersion = '1.0.0'): Promise<BundledDecision> {
  const { decideBundled } = await loadDecision();
  return decideBundled({ bundledHash: I, bundledVersion, volume });
}

describe('同梱の写しにある ID', () => {
  it('#7 フォルダが無い → restored', async () => {
    expect(await decide({ kind: 'missing' })).toEqual({ result: 'restored' });
  });

  it.each<readonly [string, VolumeState]>([
    ['H = I で印が一致していても', present({ hash: I, markerHash: I, quarantined: true })],
    ['有効な印があり H = M ≠ I でも', present({ hash: X, markerHash: X, quarantined: true })],
    ['有効な印があり H ≠ M でも', present({ hash: X, markerHash: Y, quarantined: true })],
    ['印が無く版が同じでも', present({ hash: X, quarantined: true })],
    ['印が無く版が読めなくても', present({ hash: X, version: null, quarantined: true })],
  ])('#8 隔離マークがある → skipped: quarantined（%s）', async (_label, volume) => {
    expect(await decide(volume)).toEqual({ result: 'skipped', reason: 'quarantined' });
  });

  it('#9 H = I で印が一致（M = I）→ unchanged', async () => {
    expect(await decide(present({ hash: I, markerHash: I }))).toEqual({ result: 'unchanged' });
  });

  it('#9 H = I で印が無い → adopted（印だけ書く）', async () => {
    expect(await decide(present({ hash: I, markerHash: null }))).toEqual({ result: 'adopted' });
  });

  it('#9 H = I で M ≠ I → adopted（印だけ書き直す）', async () => {
    expect(await decide(present({ hash: I, markerHash: X }))).toEqual({ result: 'adopted' });
  });

  it('#9 H = I で印が壊れている（parseMarker が null）→ adopted', async () => {
    const { parseMarker } = await loadDecision();

    const markerHash = parseMarker('{ this is not json');

    expect(await decide(present({ hash: I, markerHash }))).toEqual({ result: 'adopted' });
  });

  it('#9 H = I なら、印が無くても Volume の版や plugin.json の読めなさは問わない（#3 が #6〜#8 より先）', async () => {
    expect(await decide(present({ hash: I, markerHash: null, version: null }))).toEqual({
      result: 'adopted',
    });
    expect(await decide(present({ hash: I, markerHash: null, version: '9.9.9' }))).toEqual({
      result: 'adopted',
    });
  });

  it('#10 有効な印があり H = M ≠ I → updated（退避なし）', async () => {
    expect(await decide(present({ hash: X, markerHash: X }))).toEqual({
      result: 'updated',
      backup: false,
    });
  });

  it('#10 有効な印があれば版は見ない（Volume の版が新しくても H = M なら updated）', async () => {
    expect(await decide(present({ hash: X, markerHash: X, version: '9.9.9' }))).toEqual({
      result: 'updated',
      backup: false,
    });
  });

  it('#11 有効な印があり H ≠ M・H ≠ I → skipped: modified', async () => {
    expect(await decide(present({ hash: X, markerHash: Y }))).toEqual({
      result: 'skipped',
      reason: 'modified',
    });
  });

  it('#11 有効な印があれば版は見ない（Volume の版が古くても H ≠ M なら skipped: modified）', async () => {
    expect(await decide(present({ hash: X, markerHash: Y, version: '0.0.1' }), '1.0.0')).toEqual({
      result: 'skipped',
      reason: 'modified',
    });
  });

  it.each([
    ['1.1.0', '1.0.0'],
    ['1.10.0', '1.9.0'],
    ['2.0.0', '1.99.99'],
  ])(
    '#12 印が無く、Volume の版（%s）がイメージの版（%s）より新しい → skipped: newer version',
    async (volumeVersion, bundledVersion) => {
      expect(await decide(present({ hash: X, version: volumeVersion }), bundledVersion)).toEqual({
        result: 'skipped',
        reason: 'newer version',
        installedVersion: volumeVersion,
      });
    },
  );

  it.each([
    ['1.0.0', '1.0.0', '同じ'],
    ['1.2', '1.2.0', '同じ（桁数違い）'],
    ['0.9.0', '1.0.0', '古い'],
    ['1.9.0', '1.10.0', '古い（数値で比べる）'],
  ])(
    '#13 印が無く、Volume の版（%s）がイメージの版（%s）と%s → updated: legacy（退避あり）',
    async (volumeVersion, bundledVersion) => {
      expect(await decide(present({ hash: X, version: volumeVersion }), bundledVersion)).toEqual({
        result: 'updated',
        backup: true,
      });
    },
  );

  it('#14 印が無く、plugin.json の version が読めない（観測値 null）→ skipped: unreadable manifest', async () => {
    expect(await decide(present({ hash: X, version: null }))).toEqual({
      result: 'skipped',
      reason: 'unreadable manifest',
    });
  });
});

describe('印の解釈', () => {
  const valid = (hash: unknown): string =>
    JSON.stringify({
      schema: 1,
      note: 'n',
      hash,
      version: '1.0.0',
      syncedAt: '2026-10-02T00:00:00Z',
    });

  it('#15 JSON として読めて hash が sha256:<64 桁の 16 進> の印は、その hash を返す', async () => {
    const { parseMarker } = await loadDecision();

    expect(parseMarker(valid(I))).toBe(I);
  });

  it('#15 hash さえ正しければ他の項目が欠けていても有効な印とみなす', async () => {
    const { parseMarker } = await loadDecision();

    expect(parseMarker(JSON.stringify({ hash: X }))).toBe(X);
  });

  it.each<readonly [string, string]>([
    ['JSON でない', '{ "hash": "sha256:'],
    ['空の文字列', ''],
    ['sha256: の無い 64 桁', valid('a'.repeat(64))],
    ['63 桁', valid(`sha256:${'a'.repeat(63)}`)],
    ['65 桁', valid(`sha256:${'a'.repeat(65)}`)],
    ['大文字の 16 進', valid(`sha256:${'A'.repeat(64)}`)],
    ['16 進でない文字', valid(`sha256:${'g'.repeat(64)}`)],
    ['hash が文字列でない', valid(123)],
    ['hash が無い', JSON.stringify({ schema: 1, version: '1.0.0' })],
    ['JSON の null', 'null'],
    ['JSON の配列', `["${I}"]`],
    ['JSON の文字列', JSON.stringify(I)],
  ])('#15 印が無効（%s）なら null を返す', async (_label, raw) => {
    const { parseMarker } = await loadDecision();

    expect(parseMarker(raw)).toBeNull();
  });

  it('#15 無効な印は「印なし」として扱われ、Volume の版が新しければ skipped: newer version（#12）', async () => {
    const { parseMarker } = await loadDecision();
    const markerHash = parseMarker(valid(`sha256:${'b'.repeat(63)}`));

    expect(await decide(present({ hash: X, markerHash, version: '1.1.0' }), '1.0.0')).toEqual({
      result: 'skipped',
      reason: 'newer version',
      installedVersion: '1.1.0',
    });
  });

  it('#15 無効な印は「印なし」として扱われ、版が同じなら updated: legacy（#13）', async () => {
    const { parseMarker } = await loadDecision();
    // 16 進の部分は H と同じでも、sha256: が無いので有効な印ではない（#4 の updated・退避なしにならない）。
    const markerHash = parseMarker(valid('b'.repeat(64)));

    expect(await decide(present({ hash: X, markerHash, version: '1.0.0' }), '1.0.0')).toEqual({
      result: 'updated',
      backup: true,
    });
  });

  it('#15 無効な印は「印なし」として扱われ、版が読めなければ skipped: unreadable manifest（#14）', async () => {
    const { parseMarker } = await loadDecision();
    const markerHash = parseMarker('not json at all');

    expect(await decide(present({ hash: X, markerHash, version: null }))).toEqual({
      result: 'skipped',
      reason: 'unreadable manifest',
    });
  });
});

describe('同梱の写しに無い ID', () => {
  it('#16 有効な印がある（以前は同梱だった）→ kept', async () => {
    const { decideUnbundled } = await loadDecision();

    expect(decideUnbundled(X)).toBe('kept');
  });

  it('#16 印が無い（利用者の Plugin）→ untouched', async () => {
    const { decideUnbundled } = await loadDecision();

    expect(decideUnbundled(null)).toBe('untouched');
  });
});
