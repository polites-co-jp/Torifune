import { randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { withConnection } from '@/application/transaction';
import { encryptSecret } from '@/infrastructure/crypto/cipher';
import { socialRepository } from '@/infrastructure/social-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * 資格情報の版（`credentialVersion`）と比較更新の口（`replaceCredentialIfUnchanged`）
 * （039-social-credential-fields 設計 §6.1 の 2、受け入れ条件 #63、#64）。
 *
 * * 版は**保存されている暗号文そのもの**。比較更新にだけ使う不透明な値
 * * 比較更新は 1 文の `UPDATE … WHERE id = ? AND credential = ?`。置き換えたら true、
 *   版が違う・アカウントが無い・id の形が不正なら false で、何も変えない
 *
 * Repository を `withConnection` の中で直接呼ぶ（置き場は実装プラン §8 の 24）。
 * 行は DB へ直接入れる（UseCase・登録簿を通さない。見たいのは Repository の口だけ）。
 */

let scratch: ScratchDatabase;

/** かなり前の時刻。`updated_at` が「進んだ」「変わらない」を等値で見分けるために置く。 */
const LONG_AGO = new Date('2001-02-03T04:05:06.000Z');

async function insertAccount(credential: string | null): Promise<string> {
  const id = uuidv7();
  await withConnection(async (connection) => {
    await connection.db
      .insertInto('social_accounts')
      .values({
        id,
        provider: 'testsns',
        display_name: '版のテスト',
        credential,
        updated_at: LONG_AGO,
      })
      .execute();
  });
  return id;
}

interface Row {
  readonly credential: string | null;
  readonly updatedAt: Date;
}

async function rowOf(id: string): Promise<Row> {
  const row = await withConnection(async (connection) =>
    connection.db
      .selectFrom('social_accounts')
      .select(['credential', 'updated_at'])
      .where('id', '=', id)
      .executeTakeFirst(),
  );
  if (row === undefined) throw new Error(`アカウントが無い: ${id}`);
  return { credential: row.credential, updatedAt: new Date(row.updated_at as unknown as Date) };
}

async function replace(id: string, expectedVersion: string, encrypted: string): Promise<boolean> {
  return withConnection((connection) =>
    socialRepository.replaceCredentialIfUnchanged(connection, id, expectedVersion, encrypted),
  );
}

async function withCredential(id: string) {
  return withConnection((connection) => socialRepository.findAccountWithCredential(connection, id));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('socialcredentialversion');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('social_accounts').execute();
  });
});

// ---------------------------------------------------------------------------
// #63 replaceCredentialIfUnchanged
// ---------------------------------------------------------------------------

describe('#63 replaceCredentialIfUnchanged：保存されている暗号文を expectedVersion に渡す', () => {
  async function matched() {
    const stored = encryptSecret(JSON.stringify({ identifier: 'a', appPassword: 'b' }));
    const id = await insertAccount(stored);
    const next = encryptSecret(JSON.stringify({ identifier: 'a', appPassword: 'new' }));
    const result = await replace(id, stored, next);
    return { id, stored, next, result };
  }

  it('#63 true を返す', async () => {
    const { result } = await matched();

    expect(result).toBe(true);
  });

  it('#63 credential が渡した新しい暗号文に置き換わる', async () => {
    const { id, next } = await matched();

    expect((await rowOf(id)).credential).toBe(next);
  });

  it('#63 updated_at が進む', async () => {
    const { id } = await matched();

    expect((await rowOf(id)).updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
  });

  it('#63 同じ暗号文を持つ別の行は変わらない（id で絞る）', async () => {
    const stored = encryptSecret('shared');
    const target = await insertAccount(stored);
    const other = await insertAccount(stored);

    await replace(target, stored, encryptSecret('next'));

    expect(await rowOf(other)).toEqual({ credential: stored, updatedAt: LONG_AGO });
  });
});

describe('#63 replaceCredentialIfUnchanged：違う値を expectedVersion に渡す', () => {
  async function mismatched() {
    const stored = encryptSecret(JSON.stringify({ identifier: 'a', appPassword: 'b' }));
    const id = await insertAccount(stored);
    // 同じ平文でも IV が違うので別の暗号文になる（運用者が同じ値を入れ直した場合と同じ）。
    const otherVersion = encryptSecret(JSON.stringify({ identifier: 'a', appPassword: 'b' }));
    const result = await replace(id, otherVersion, encryptSecret('next'));
    return { id, stored, result };
  }

  it('#63 false を返す', async () => {
    const { result } = await mismatched();

    expect(result).toBe(false);
  });

  it('#63 credential が変わらない', async () => {
    const { id, stored } = await mismatched();

    expect((await rowOf(id)).credential).toBe(stored);
  });

  it('#63 updated_at が変わらない', async () => {
    const { id } = await mismatched();

    expect((await rowOf(id)).updatedAt.getTime()).toBe(LONG_AGO.getTime());
  });
});

describe('#63 replaceCredentialIfUnchanged：置き換えられない行', () => {
  it('#63 credential が NULL の行は false で、NULL のまま・updated_at も変わらない', async () => {
    const id = await insertAccount(null);

    expect(await replace(id, encryptSecret('anything'), encryptSecret('next'))).toBe(false);
    expect(await rowOf(id)).toEqual({ credential: null, updatedAt: LONG_AGO });
  });

  it('#63 存在しない ID は false', async () => {
    expect(await replace(uuidv7(), encryptSecret('anything'), encryptSecret('next'))).toBe(false);
  });

  it('#63 UUID の形でない ID は false（例外にしない）', async () => {
    expect(await replace('not-a-uuid', encryptSecret('anything'), encryptSecret('next'))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// #64 findAccountWithCredential の credentialVersion
// ---------------------------------------------------------------------------

describe('#64 findAccountWithCredential の credentialVersion', () => {
  it('#64 credentialVersion が social_accounts.credential の値ちょうど', async () => {
    const stored = encryptSecret(JSON.stringify({ identifier: 'a', appPassword: 'b' }));
    const id = await insertAccount(stored);

    expect((await withCredential(id))?.credentialVersion).toBe(stored);
  });

  it('#64 復号できる行では credential も現行どおり復号した値', async () => {
    const id = await insertAccount(encryptSecret('plain-value-6e1c'));

    expect((await withCredential(id))?.credential?.expose()).toBe('plain-value-6e1c');
  });

  it('#64 資格情報が無ければ（NULL）credentialVersion は null', async () => {
    const id = await insertAccount(null);

    expect((await withCredential(id))?.credentialVersion).toBeNull();
  });

  it("#64 列が '' のときも credentialVersion は null（実装プラン §8 の 25）", async () => {
    const id = await insertAccount('');

    expect((await withCredential(id))?.credentialVersion).toBeNull();
  });

  it('#64 暗号文が壊れていて復号できない行でも credentialVersion は載り、credential は null', async () => {
    const broken = 'v1.k1.not-a-valid-ciphertext';
    const id = await insertAccount(broken);
    const found = await withCredential(id);

    expect(found?.credentialVersion).toBe(broken);
    expect(found?.credential).toBeNull();
  });

  it('#64 別の鍵で暗号化された（復号できない）行でも credentialVersion は載り、credential は null', async () => {
    const otherKey = encryptSecret('other-key-value', { id: 'k9', material: randomBytes(32) });
    const id = await insertAccount(otherKey);
    const found = await withCredential(id);

    expect(found?.credentialVersion).toBe(otherKey);
    expect(found?.credential).toBeNull();
  });
});
