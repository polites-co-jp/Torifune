import { KNOWN_PROVIDERS, providerLabel } from '@/domain/social/social';
import type { ProviderCredentialField, ProviderOption } from '@/ui/social/social-accounts';

/**
 * 「サービス」の選択肢の組み立て（039-social-credential-fields 設計 §7.1）。
 *
 * **登録簿の型に直接依存しない**（設計 §4）。受け取るのは publisher の一覧の最小の形で、
 * `app/social/page.tsx` が `listPublishers()` の結果を渡す。
 */
export interface PublisherOptionSource {
  /**
   * publisher を登録した Plugin の ID（041-plugin-help-docs 設計 §7.4.1）。
   * 手順書のリンクを引くのに使う。省略すると手順書を引かない。
   */
  readonly pluginId?: string;
  readonly registration: {
    readonly provider: string;
    readonly label: string;
    readonly credentialFields: readonly {
      readonly key: string;
      readonly label: string;
      readonly kind: 'text' | 'secret';
      readonly description?: string;
      readonly placeholder?: string;
    }[];
  };
}

/**
 * publisher の一覧 → `ProviderOption[]`。
 *
 * * 並びは `KNOWN_PROVIDERS` → 登録簿の provider（同じ provider は 1 回だけ）
 * * `label` は publisher の `label` を優先し、無ければ Core の表示名
 * * 登録簿にある provider は `publisherRegistered: true` と宣言の項目（宣言の順。
 *   `key` / `label` / `kind`、`description` は宣言にあるときだけ。**`placeholder` は持ち込まない**）
 * * 無い provider は `publisherRegistered: false` と `[]`
 * * `helpOf` を渡すと、`pluginId` を持つ publisher の Plugin の先頭の手順書を `help: { href, title }` に持たせる
 *   （041-plugin-help-docs 設計 §7.4.1）。`helpOf` が `null` を返す・`pluginId` が無い・登録簿に無い provider は
 *   `help` のキーを持たない。省略すれば、どの選択肢も `help` を持たない（039 の呼び出しと同じ結果）
 */
export function buildProviderOptions(
  publishers: readonly PublisherOptionSource[],
  helpOf?: (pluginId: string) => { readonly href: string; readonly title: string } | null,
): ProviderOption[] {
  const registrations = new Map<string, PublisherOptionSource['registration']>();
  const pluginIds = new Map<string, string>();
  const labels: Record<string, string> = {};
  for (const { pluginId, registration } of publishers) {
    registrations.set(registration.provider, registration);
    if (pluginId === undefined) {
      pluginIds.delete(registration.provider);
    } else {
      pluginIds.set(registration.provider, pluginId);
    }
    labels[registration.provider] = registration.label;
  }

  const values = [...new Set<string>([...KNOWN_PROVIDERS, ...registrations.keys()])];

  // 登録簿にある provider だけ。`KNOWN_PROVIDERS` にだけある provider は Plugin が分からない。
  const helpLinkOf = (
    provider: string,
  ): { readonly href: string; readonly title: string } | null => {
    const pluginId = pluginIds.get(provider);
    return helpOf === undefined || pluginId === undefined ? null : helpOf(pluginId);
  };

  return values.map((value) => {
    const registration = registrations.get(value);
    const help = helpLinkOf(value);
    return {
      value,
      label: providerLabel(value, labels),
      credentialFields: (registration?.credentialFields ?? []).map(
        (field): ProviderCredentialField => ({
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.description === undefined ? {} : { description: field.description }),
        }),
      ),
      publisherRegistered: registration !== undefined,
      // `id` などを持ち込まず、`href` と `title` だけを写す（実装プラン §8 の 13）。
      ...(help === null ? {} : { help: { href: help.href, title: help.title } }),
    };
  });
}
