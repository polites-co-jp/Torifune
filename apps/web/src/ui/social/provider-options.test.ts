import type { PublisherRegistration } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';
import { KNOWN_PROVIDERS, providerLabel } from '@/domain/social/social';
import { credentialInputOf } from './credential-form';
import { buildProviderOptions } from './provider-options';
import type { ProviderOption } from './social-accounts';

/**
 * 「サービス」の選択肢の組み立て（039-social-credential-fields 設計 §7.1、受け入れ条件 #5〜#8）。
 *
 * Server Component（`app/social/page.tsx`）が `listPublishers()` の結果を渡す。
 * ここでは登録簿の 1 件と同じ形（`{ pluginId, registration }`）を作って渡す。
 *
 * * 登録簿にある provider：`publisherRegistered: true` と宣言の項目（`key` / `label` / `kind` / `description`、
 *   宣言の順。**`placeholder` は持ち込まない**。`description` を宣言しない項目は `description` を持たない）
 * * 無い provider：`publisherRegistered: false` と `[]`
 * * 並びと `label` の決め方は現行と同じ（`KNOWN_PROVIDERS` → 登録簿の provider、publisher の `label` を優先）
 */

interface PublisherEntry {
  readonly pluginId: string;
  readonly registration: PublisherRegistration;
}

function publisher(
  provider: string,
  label: string,
  credentialFields: PublisherRegistration['credentialFields'],
): PublisherEntry {
  return { pluginId: `${provider}-plugin`, registration: { provider, label, credentialFields } };
}

const BLUESKY = publisher('bluesky', 'Bluesky（Plugin）', [
  {
    key: 'identifier',
    label: '識別子',
    description: 'ハンドルまたはメールアドレス。',
    kind: 'text',
    placeholder: 'example.bsky.social',
  },
  {
    key: 'appPassword',
    label: 'アプリパスワード',
    kind: 'secret',
    placeholder: 'xxxx-xxxx-xxxx-xxxx',
  },
]);

const X_EMPTY = publisher('x', 'X（手動）', []);

const EXAMPLE = publisher('example', 'サンプルSNS', [
  { key: 'handle', label: 'サンプルSNSのハンドル', kind: 'text' },
]);

function optionOf(options: readonly ProviderOption[], value: string): ProviderOption {
  const found = options.find((option) => option.value === value);
  if (found === undefined) throw new Error(`選択肢が無い: ${value}`);
  return found;
}

describe('#5 項目を宣言した publisher の選択肢', () => {
  it('#5 publisherRegistered が true', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    expect(option.publisherRegistered).toBe(true);
  });

  it('#5 credentialFields が宣言の順で key / label / kind / description だけを持つ', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    expect(option.credentialFields).toStrictEqual([
      {
        key: 'identifier',
        label: '識別子',
        kind: 'text',
        description: 'ハンドルまたはメールアドレス。',
      },
      { key: 'appPassword', label: 'アプリパスワード', kind: 'secret' },
    ]);
  });

  it('#5 description を宣言した項目のキー集合は key / label / kind / description ちょうど', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    expect(Object.keys(option.credentialFields[0] ?? {}).sort()).toEqual(
      ['description', 'key', 'kind', 'label'].sort(),
    );
  });

  it('#5 description を宣言しない項目は description のキーを持たない', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');
    const field = option.credentialFields[1] ?? {};

    expect('description' in field).toBe(false);
    expect(Object.keys(field).sort()).toEqual(['key', 'kind', 'label'].sort());
  });

  it('#5 placeholder を持ち込まない', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    for (const field of option.credentialFields) {
      expect('placeholder' in field, field.key).toBe(false);
    }
  });

  it('#5 label は publisher の label', () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    expect(option.label).toBe('Bluesky（Plugin）');
  });

  it("#5 credentialInputOf が 'fields'", () => {
    const option = optionOf(buildProviderOptions([BLUESKY]), 'bluesky');

    expect(credentialInputOf(option)).toBe('fields');
  });
});

describe('#6 credentialFields: [] の publisher の選択肢', () => {
  it('#6 publisherRegistered が true、credentialFields が []', () => {
    const option = optionOf(buildProviderOptions([X_EMPTY]), 'x');

    expect(option.publisherRegistered).toBe(true);
    expect(option.credentialFields).toStrictEqual([]);
  });

  it("#6 credentialInputOf が 'none'", () => {
    const option = optionOf(buildProviderOptions([X_EMPTY]), 'x');

    expect(credentialInputOf(option)).toBe('none');
  });

  it('#6 label は publisher の label', () => {
    const option = optionOf(buildProviderOptions([X_EMPTY]), 'x');

    expect(option.label).toBe('X（手動）');
  });
});

describe('#7 publisher の無い既知の provider の選択肢', () => {
  it.each(KNOWN_PROVIDERS)('#7 %s は publisherRegistered: false と []', (value) => {
    const option = optionOf(buildProviderOptions([]), value);

    expect(option.publisherRegistered).toBe(false);
    expect(option.credentialFields).toStrictEqual([]);
  });

  it.each(KNOWN_PROVIDERS)('#7 %s の label は Core の表示名', (value) => {
    const option = optionOf(buildProviderOptions([]), value);

    expect(option.label).toBe(providerLabel(value));
  });

  it.each(KNOWN_PROVIDERS)("#7 %s の credentialInputOf が 'free'", (value) => {
    const option = optionOf(buildProviderOptions([]), value);

    expect(credentialInputOf(option)).toBe('free');
  });

  it('#7 他の provider に publisher があっても、無い provider は false と [] のまま', () => {
    const option = optionOf(buildProviderOptions([BLUESKY, X_EMPTY]), 'facebook');

    expect(option.publisherRegistered).toBe(false);
    expect(option.credentialFields).toStrictEqual([]);
    expect(option.label).toBe(providerLabel('facebook'));
  });
});

describe('#8 並び', () => {
  it('#8 publisher が無ければ KNOWN_PROVIDERS の順ちょうど', () => {
    const values = buildProviderOptions([]).map((option) => option.value);

    expect(values).toEqual([...KNOWN_PROVIDERS]);
  });

  it('#8 KNOWN_PROVIDERS に無い provider の publisher は KNOWN_PROVIDERS の後ろに並ぶ', () => {
    const values = buildProviderOptions([EXAMPLE]).map((option) => option.value);

    expect(values).toEqual([...KNOWN_PROVIDERS, 'example']);
  });

  it('#8 KNOWN_PROVIDERS の provider の publisher は既知の位置に 1 回だけ現れる', () => {
    const values = buildProviderOptions([EXAMPLE, BLUESKY, X_EMPTY]).map((option) => option.value);

    expect(values).toEqual([...KNOWN_PROVIDERS, 'example']);
    expect(values.filter((value) => value === 'bluesky')).toHaveLength(1);
    expect(values.filter((value) => value === 'x')).toHaveLength(1);
  });

  it('#8 KNOWN_PROVIDERS に無い provider の publisher は宣言の項目と label を持つ', () => {
    const option = optionOf(buildProviderOptions([EXAMPLE]), 'example');

    expect(option).toStrictEqual({
      value: 'example',
      label: 'サンプルSNS',
      credentialFields: [{ key: 'handle', label: 'サンプルSNSのハンドル', kind: 'text' }],
      publisherRegistered: true,
    });
  });
});
