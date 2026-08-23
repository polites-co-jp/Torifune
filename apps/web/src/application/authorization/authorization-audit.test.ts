import { beforeEach, describe, expect, it } from 'vitest';
import { declarePublicUseCases } from './public-use-cases';
import { listUnprotectedUseCases, listUseCases, resetUseCaseRegistry } from './use-case';

/**
 * 「認可されていない処理」を一覧として固定する監査テスト。
 *
 * 新しく認可なしの処理が増えると、このテストが落ちる。
 * **落ちたときは一覧を増やす前に、本当に認可が不要かを考えること。**
 */

beforeEach(() => {
  resetUseCaseRegistry();
  declarePublicUseCases();
});

describe('認可を必要としない処理', () => {
  it('一覧が想定どおりである', () => {
    expect(
      listUnprotectedUseCases()
        .map((u) => u.name)
        .sort(),
    ).toEqual([
      'auth.currentUser',
      'auth.login',
      'auth.logout',
      'auth.passwordReset.confirm',
      'auth.passwordReset.request',
      'setup.complete',
    ]);
  });

  it('すべてに理由が書かれている', () => {
    for (const useCase of listUnprotectedUseCases()) {
      expect(useCase.reason, `${useCase.name} に理由が無い`).toBeTruthy();
      expect((useCase.reason ?? '').length).toBeGreaterThan(5);
    }
  });

  it('認可が必要な処理には Permission が設定されている', () => {
    const missing = listUseCases().filter(
      (useCase) => useCase.permission === null && useCase.reason === null,
    );
    expect(missing.map((u) => u.name)).toEqual([]);
  });
});
