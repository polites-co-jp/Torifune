import { PluginDataInputError, PluginPermissionError } from '@torifune/plugin-api';
import { describe, expect, it } from 'vitest';

/**
 * 公開 Plugin API に足す `PluginDataInputError`（043-api-input-fixes-rest 設計 §9.2、受け入れ条件 #34）。
 *
 * **公開 Plugin API の入口（`@torifune/plugin-api`）から引く。** Plugin が import するのと同じ経路で確かめる。
 * `packages/plugin-api` の差分をクラス・export・コメントに限る（#49）ため、このテストは本体側に置く
 * （実装プラン §8 の 5）。
 */

describe('#34 PluginDataInputError は公開 Plugin API の入口から取れる', () => {
  it('#34 @torifune/plugin-api から取れ、関数（クラス）である', () => {
    expect(typeof PluginDataInputError).toBe('function');
  });
});

describe('#34 PluginDataInputError の形', () => {
  function make(): PluginDataInputError {
    return new PluginDataInputError('p', 'accountId');
  }

  it('#34 instanceof Error', () => {
    expect(make()).toBeInstanceOf(Error);
  });

  it("#34 name === 'PluginDataInputError'", () => {
    expect(make().name).toBe('PluginDataInputError');
  });

  it("#34 pluginId === 'p'", () => {
    expect(make().pluginId).toBe('p');
  });

  it("#34 field === 'accountId'", () => {
    expect(make().field).toBe('accountId');
  });

  it('#34 message が引数名 accountId を含む', () => {
    expect(make().message).toContain('accountId');
  });

  it('#34 PluginPermissionError ではない（権限の誤りと入力の誤りを分ける）', () => {
    expect(make()).not.toBeInstanceOf(PluginPermissionError);
  });
});
