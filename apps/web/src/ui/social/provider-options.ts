import { KNOWN_PROVIDERS, providerLabel } from '@/domain/social/social';
import type { ProviderCredentialField, ProviderOption } from '@/ui/social/social-accounts';

/**
 * 「サービス」の選択肢の組み立て（039-social-credential-fields 設計 §7.1）。
 *
 * **登録簿の型に直接依存しない**（設計 §4）。受け取るのは publisher の一覧の最小の形で、
 * `app/social/page.tsx` が `listPublishers()` の結果を渡す。
 */
export interface PublisherOptionSource {
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
 */
export function buildProviderOptions(
  publishers: readonly PublisherOptionSource[],
): ProviderOption[] {
  const registrations = new Map<string, PublisherOptionSource['registration']>();
  const labels: Record<string, string> = {};
  for (const { registration } of publishers) {
    registrations.set(registration.provider, registration);
    labels[registration.provider] = registration.label;
  }

  const values = [...new Set<string>([...KNOWN_PROVIDERS, ...registrations.keys()])];

  return values.map((value) => {
    const registration = registrations.get(value);
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
    };
  });
}
