import { PluginPublisherConflictError, type PublisherRegistration } from '@torifune/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findPublisher,
  listPublishers,
  publisherLabels,
  registerPublisher,
  resetPublisherRegistry,
  unregisterPublishersOf,
} from './publisher-registry';

/**
 * publisher の登録簿（035-social-publishing 設計 §9.4 / §9.7）。
 *
 * 受け入れ条件 #13（登録・検索・一覧・ラベル・解除）と
 * #14（重複・置き換え・不正な provider）。**DB は要らない。**
 */

function registrationFor(overrides: Partial<PublisherRegistration> = {}): PublisherRegistration {
  return {
    provider: 'x',
    label: 'X（テスト）',
    credentialFields: [],
    ...overrides,
  };
}

afterEach(() => {
  // **プロセスに1つの登録簿なので、テストの間で持ち越さない。**
  resetPublisherRegistry();
});

describe('#13 登録・検索・一覧・ラベル・解除', () => {
  it('#13 登録した publisher を provider で引ける', () => {
    const registration = registrationFor();

    registerPublisher('p1', registration);

    expect(findPublisher('x')).toEqual({ pluginId: 'p1', registration });
  });

  it('#13 登録の無い provider は null', () => {
    registerPublisher('p1', registrationFor());

    expect(findPublisher('unknown_provider')).toBeNull();
  });

  it('#13 登録した publisher が一覧に 1 件出る', () => {
    registerPublisher('p1', registrationFor());

    expect(listPublishers()).toHaveLength(1);
  });

  it('#13 一覧の要素が登録した Plugin ID を持つ', () => {
    registerPublisher('p1', registrationFor());

    expect(listPublishers()[0]?.pluginId).toBe('p1');
  });

  it('#13 publisherLabels が provider と表示名の対応を返す', () => {
    // `providerLabel(provider, overrides)` の overrides にそのまま渡せる形。
    registerPublisher('p1', registrationFor({ label: 'X（テスト）' }));

    expect(publisherLabels()).toEqual({ x: 'X（テスト）' });
  });

  it('#13 解除した publisher は引けなくなる', () => {
    registerPublisher('p1', registrationFor());

    unregisterPublishersOf('p1');

    expect(findPublisher('x')).toBeNull();
  });

  it('#13 解除すると一覧が 0 件になる', () => {
    registerPublisher('p1', registrationFor());

    unregisterPublishersOf('p1');

    expect(listPublishers()).toHaveLength(0);
  });

  it('#13 解除しても他の Plugin の登録は残る', () => {
    // 解除が Plugin をまたぐと、無効化した Plugin の巻き添えで
    // 別の Plugin の配信が止まる。
    registerPublisher('p1', registrationFor({ provider: 'x' }));
    registerPublisher('p2', registrationFor({ provider: 'bluesky', label: 'Bluesky（テスト）' }));

    unregisterPublishersOf('p1');

    expect(findPublisher('bluesky')).toMatchObject({ pluginId: 'p2' });
  });
});

describe('#14 重複・置き換え・provider の形式', () => {
  it('#14 別の Plugin が同じ provider を登録すると PluginPublisherConflictError', () => {
    registerPublisher('p1', registrationFor());

    expect(() => {
      registerPublisher('p2', registrationFor({ label: 'X（あとから）' }));
    }).toThrowError(PluginPublisherConflictError);
  });

  it('#14 衝突した例外に provider と先に登録した Plugin ID が入る', () => {
    registerPublisher('p1', registrationFor());

    try {
      registerPublisher('p2', registrationFor({ label: 'X（あとから）' }));
      expect.unreachable();
    } catch (error) {
      const typed = error as PluginPublisherConflictError;
      expect({ provider: typed.provider, registeredBy: typed.registeredBy }).toEqual({
        provider: 'x',
        registeredBy: 'p1',
      });
    }
  });

  it('#14 衝突しても先に登録した Plugin の登録が残る', () => {
    // **先に有効化されたほうが勝つ**（設計 §9.4）。
    registerPublisher('p1', registrationFor());

    try {
      registerPublisher('p2', registrationFor({ label: 'X（あとから）' }));
    } catch {
      // ここでは衝突したことではなく、残っているほうを見る。
    }

    expect(findPublisher('x')).toMatchObject({ pluginId: 'p1' });
  });

  it('#14 同じ Plugin が同じ provider を登録し直しても件数は 1 のまま', () => {
    // `next dev` の再有効化で登録が増殖しないこと。
    registerPublisher('p1', registrationFor());

    registerPublisher('p1', registrationFor({ label: 'X（登録し直し）' }));

    expect(listPublishers()).toHaveLength(1);
  });

  it('#14 同じ Plugin が同じ provider を登録し直すと置き換わる', () => {
    registerPublisher('p1', registrationFor());

    registerPublisher('p1', registrationFor({ label: 'X（登録し直し）' }));

    expect(findPublisher('x')?.registration.label).toBe('X（登録し直し）');
  });

  it('#14 provider の形式が不正なら Error', () => {
    expect(() => {
      registerPublisher('p1', registrationFor({ provider: 'X.com' }));
    }).toThrowError(/形式/);
  });

  it('#14 形式が不正な provider は登録簿に入らない', () => {
    try {
      registerPublisher('p1', registrationFor({ provider: 'X.com' }));
    } catch {
      // 例外そのものは前のテストで見ている。
    }

    expect(listPublishers()).toHaveLength(0);
  });
});
