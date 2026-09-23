import type { PluginSettingsField, PluginStore, SettingsRegistration } from '@torifune/plugin-api';

/**
 * PDS の URL の宣言・検証・解決（036-sns-bluesky 設計 §7.1 / §7.2）。
 *
 * **この Plugin が状態を持つのはこの1件だけ。** 投稿の状態も資格情報も持たない。
 */

/** 既定の PDS。未設定・空文字はここへ落とす。 */
export const DEFAULT_PDS_URL = 'https://bsky.social';

/**
 * Key-Value Store のキー。
 *
 * **`pdsUrl` にしない。** 設定の項目名はそのままキーになり、
 * `STORE_KEY_PATTERN`（`^[a-z0-9][a-z0-9._/-]{0,127}$`）は大文字を許さない（設計 §7.1）。
 */
export const PDS_URL_KEY = 'pds-url';

const PDS_URL_MAX_LENGTH = 2048;

export const pdsUrlField: PluginSettingsField = {
  key: PDS_URL_KEY,
  label: 'PDS の URL',
  description:
    '投稿先の PDS（Personal Data Server）。通常は変更しません。空欄なら https://bsky.social を使います。' +
    '自分で PDS を運用している場合だけ、その URL を入れてください。' +
    'ここで指定したサーバへ、登録された App Password がそのまま送られます。',
  // **secret にしない。** URL は秘密ではなく、secret にすると
  // どこへ App Password を送っているかを運用者が確かめられなくなる（設計 §7.1）。
  kind: 'text',
  placeholder: DEFAULT_PDS_URL,
};

/**
 * PDS の URL として受け付けるか。問題があればその文言を、無ければ `null` を返す。
 *
 * **保存時と配信時の両方で使う**（設計 §7.2）。設定は Key-Value Store の値であり、
 * Plugin の版を上げて検査を厳しくしたときに古い値が残る。
 */
export function validatePdsUrl(value: string): string | null {
  if (value === '') {
    // 空欄は既定へ落とすので問題としない。
    return null;
  }
  if (value.length > PDS_URL_MAX_LENGTH) {
    return '長すぎます。';
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'URL の形式が不正です。';
  }

  if (url.protocol !== 'https:') {
    // **http を許さない。** そこへ App Password を平文で送ることになる。
    return 'https の URL を入れてください。';
  }
  if (url.username !== '' || url.password !== '') {
    return 'URL に利用者名やパスワードを書かないでください。';
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return 'PDS の URL はホストまでを入れてください（例：https://bsky.social）。';
  }

  return null;
}

/**
 * 設定画面の宣言。**描画と保存は Core が行う**（設計 §7）。
 *
 * `index.ts` がこれをそのまま `ui.registerSettings()` へ渡す。
 */
export const pdsSettingsRegistration: SettingsRegistration = {
  fields: [pdsUrlField],
  validate: (values) => {
    const problem = validatePdsUrl(values[PDS_URL_KEY] ?? '');
    return problem === null ? null : { [PDS_URL_KEY]: problem };
  },
};

export type PdsUrlResolution =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string };

/**
 * 配信時に使う PDS の URL を決める。
 *
 * **`publish()` の中から毎回呼ぶ。** `activate()` の時点で読んで閉じ込めると、
 * 設定を変えても再起動するまで効かない（設計 §7.1）。
 *
 * **保存時に通っていても、ここでもう一度検査する**（設計 §7.2）。
 * `store.get` が失敗したときは例外がそのまま上がる（呼び出し側が P0 として扱う）。
 */
export async function resolvePdsUrl(store: PluginStore): Promise<PdsUrlResolution> {
  const stored = await store.get<string>(PDS_URL_KEY);
  const value = typeof stored === 'string' ? stored.trim() : '';

  if (value === '') {
    return { ok: true, url: DEFAULT_PDS_URL };
  }

  const problem = validatePdsUrl(value);
  if (problem !== null) {
    return { ok: false, reason: problem };
  }

  // 末尾のスラッシュを落としてから `${pds}/xrpc/…` を組み立てる（`//xrpc` にしない）。
  return { ok: true, url: value.replace(/\/+$/, '') };
}
