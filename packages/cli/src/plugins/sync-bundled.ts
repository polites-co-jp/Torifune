import { compareVersions } from './version.js';

/**
 * 同梱 Plugin の同期（docs/設計/050-bundled-plugin-sync/設計.md §6.2〜§6.4・§6.6）。
 *
 * コンテナイメージは同梱 Plugin の写しを Volume の外に持つ。起動の最初に、その写しと
 * plugins の Volume を突き合わせ、**同梱 Plugin のフォルダだけ**を更新する。
 * 利用者が導入した Plugin・利用者が中身を変えた同梱 Plugin には触れない。
 *
 * 判定（§6.3）は観測値だけを受ける純関数に切り出し、ファイルシステムへの適用（§6.4）と分ける。
 */

const MARKER_HASH = /^sha256:[0-9a-f]{64}$/;

/**
 * 印（`.torifune-bundled`）の中身を読み、有効な印ならその `hash` を返す（§6.2.2）。
 *
 * JSON として読めて、`hash` が `sha256:<64 桁の 16 進>` のものだけが有効。
 * 読めない・形が違う印は「印が無い」として扱うので `null` を返す。
 */
export function parseMarker(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const hash = (parsed as Record<string, unknown>)['hash'];
  return typeof hash === 'string' && MARKER_HASH.test(hash) ? hash : null;
}

/** Volume の `<plugins>/<id>` の観測値。 */
export type VolumeState =
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'present';
      readonly quarantined: boolean;
      /** H：Volume のフォルダの木のハッシュ */
      readonly hash: string;
      /** M：有効な印の hash（有効な印が無ければ null） */
      readonly markerHash: string | null;
      /** Volume の plugin.json の version（読めない・文字列でなければ null） */
      readonly version: string | null;
    };

export type BundledDecision =
  | { readonly result: 'restored' }
  | { readonly result: 'unchanged' }
  | { readonly result: 'adopted' }
  /** `backup: true` が legacy（印の無い古い写しを退避してから置き換える） */
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

/**
 * 同梱の写しにある ID の判定（§6.3 の #1〜#8）。**上から順に最初に当たった行**を返す。
 *
 * `I` = 同梱の写しの木のハッシュ、`H` = Volume のフォルダの木のハッシュ、`M` = 有効な印の hash。
 */
export function decideBundled(input: {
  readonly bundledHash: string;
  readonly bundledVersion: string;
  readonly volume: VolumeState;
}): BundledDecision {
  const { bundledHash: I, bundledVersion, volume } = input;

  // #1 フォルダが無い → 写しを置く
  if (volume.kind === 'missing') {
    return { result: 'restored' };
  }

  // #2 隔離されたものは触らない（原因を調べるためにファイルを残す約束）
  if (volume.quarantined) {
    return { result: 'skipped', reason: 'quarantined' };
  }

  const { hash: H, markerHash: M } = volume;

  // #3 中身が同梱と同じ → 中身は触らず、印が無い・食い違うときだけ印を書く
  if (H === I) {
    return M === I ? { result: 'unchanged' } : { result: 'adopted' };
  }

  if (M !== null) {
    // #4 同期が書いたまま誰も触っていない → 黙って更新する（退避は要らない）
    // #5 同期の後に中身が変わった → 利用者のもの。触らない
    return H === M
      ? { result: 'updated', backup: false }
      : { result: 'skipped', reason: 'modified' };
  }

  // 印の無い古い Volume は版番号で補う
  // #6 plugin.json が読めない → 判断の材料が無いので触らない
  if (volume.version === null) {
    return { result: 'skipped', reason: 'unreadable manifest' };
  }
  // #7 Volume の版が新しい → 利用者が更新したもの。版を下げない
  if (compareVersions(volume.version, bundledVersion) > 0) {
    return { result: 'skipped', reason: 'newer version', installedVersion: volume.version };
  }
  // #8 同じか古い → 古いイメージから写された同梱 Plugin とみなし、退避してから置き換える
  return { result: 'updated', backup: true };
}

/**
 * 同梱の写しに無い ID の判定（§6.3 の #9・#10）。どちらも何もしない。
 *
 * 有効な印があれば以前は同梱だった Plugin（`kept`）、無ければ利用者の Plugin（`untouched`）。
 */
export function decideUnbundled(markerHash: string | null): 'kept' | 'untouched' {
  return markerHash === null ? 'untouched' : 'kept';
}
