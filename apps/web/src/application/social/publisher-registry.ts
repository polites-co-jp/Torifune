import { PluginPublisherConflictError, type PublisherRegistration } from '@torifune/plugin-api';
import { isValidProvider } from '@/domain/social/social';
import { processState } from '@/infrastructure/process-state';

/**
 * publisher（SNS 配信の実装）の登録簿。
 *
 * **`plugin/` ではなく Application に置く**（035-social-publishing 設計 §4.1）。
 * 読むのは投稿の事前検査と配信ジョブで、どちらも Application の処理であり、
 * Application から `plugin/` は import しない。
 *
 * **プロセスに1つ。** Route Handler と Server Component が別の実体を見ると
 * 「API では弾かれるのに画面には出る」という壊れ方をする。
 */

export interface RegisteredPublisher {
  readonly pluginId: string;
  readonly registration: PublisherRegistration;
}

const publishers = processState('social.publishers', () => new Map<string, RegisteredPublisher>());

/**
 * publisher を登録する。
 *
 * **先に登録したほうが勝つ。** 同じ provider を別の Plugin が握ると、
 * どちらへ資格情報が渡るかが起動順で変わる。後から来たほうを断る。
 * 同じ Plugin からの登録し直しは置き換える（開発中の再有効化で増殖しない）。
 */
export function registerPublisher(pluginId: string, registration: PublisherRegistration): void {
  const { provider } = registration;

  if (!isValidProvider(provider)) {
    // 画面と URL で扱える形に限る。`social_accounts.provider` と同じ規則。
    throw new Error(`provider の形式が不正: ${provider}`);
  }

  const existing = publishers.get(provider);
  if (existing !== undefined && existing.pluginId !== pluginId) {
    throw new PluginPublisherConflictError(provider, existing.pluginId);
  }

  publishers.set(provider, { pluginId, registration });
}

/**
 * その Plugin の登録をすべて外す。
 *
 * **外さないと、無効化したはずの Plugin へ資格情報が渡り続ける。**
 */
export function unregisterPublishersOf(pluginId: string): void {
  for (const [provider, entry] of [...publishers]) {
    if (entry.pluginId === pluginId) {
      publishers.delete(provider);
    }
  }
}

export function findPublisher(provider: string): RegisteredPublisher | null {
  return publishers.get(provider) ?? null;
}

export function listPublishers(): readonly RegisteredPublisher[] {
  return [...publishers.values()];
}

/** provider の表示名。`providerLabel(provider, overrides)` の `overrides` にそのまま渡せる形。 */
export function publisherLabels(): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const [provider, entry] of publishers) {
    labels[provider] = entry.registration.label;
  }
  return labels;
}

/** テスト用。 */
export function resetPublisherRegistry(): void {
  publishers.clear();
}
