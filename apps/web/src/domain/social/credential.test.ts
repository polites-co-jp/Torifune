import { describe, expect, it } from 'vitest';
import {
  type CredentialField,
  parseCredentialObject,
  validateCredentialAgainstFields,
} from './credential';

/**
 * 資格情報の JSON 形式（035-social-publishing 設計 §5.6.3、受け入れ条件 #10）。
 *
 * **Domain 層の単体テスト。** 暗号化も DB も知らない。
 * ここが扱うのは「復号した平文が publisher の宣言した形に合っているか」だけ。
 */

/** `credentialFields` の 1 項目。`kind` は入力欄の見え方だけの違い（§5.7）。 */
function field(key: string, kind: CredentialField['kind'] = 'text'): CredentialField {
  return { key, kind };
}

describe('parseCredentialObject', () => {
  /** #10 */
  it('値がすべて文字列の JSON オブジェクトを取り出す', () => {
    expect(parseCredentialObject('{"a":"b"}')).toEqual({ a: 'b' });
  });

  /** #10。自由文字列で登録済みのアカウントに後から Plugin を入れた場合（§5.7）。 */
  it('JSON でない平文は受け付けない', () => {
    expect(parseCredentialObject('plain-token')).toBeNull();
  });

  /** #10 */
  it('配列は受け付けない', () => {
    expect(parseCredentialObject('[1]')).toBeNull();
  });

  /** #10。入れ子は Plugin へ渡す `Record<string, string>` に写せない。 */
  it('入れ子のオブジェクトは受け付けない', () => {
    expect(parseCredentialObject('{"a":{"b":1}}')).toBeNull();
  });

  /** #10 */
  it('文字列でない値を含むオブジェクトは受け付けない', () => {
    expect(parseCredentialObject('{"a":1}')).toBeNull();
  });
});

describe('validateCredentialAgainstFields', () => {
  /** #10。宣言どおりなら問題なし。 */
  it('宣言された項目がそろっていれば問題を返さない', () => {
    expect(validateCredentialAgainstFields({ a: 'x' }, [field('a')])).toEqual([]);
  });

  /** #10。422 の `details` のキーは `credentials`（§6.4）。 */
  it('足りない項目を指摘する', () => {
    expect(validateCredentialAgainstFields({ a: 'x' }, [field('a'), field('b', 'secret')])).toEqual(
      [{ field: 'credentials', message: expect.stringMatching(/b を指定/) }],
    );
  });

  /** #10。宣言に無いキーは、打ち間違いを黙って保存しないために弾く。 */
  it('宣言に無い項目を指摘する', () => {
    expect(validateCredentialAgainstFields({ a: 'x', z: 'y' }, [field('a')])).toEqual([
      { field: 'credentials', message: expect.stringMatching(/z は指定できません/) },
    ]);
  });

  /** #10。資格情報の要らない配信手段では何を渡しても突き合わせない（§5.7）。 */
  it('宣言が空なら何も指摘しない', () => {
    expect(validateCredentialAgainstFields({ a: 'x' }, [])).toEqual([]);
  });
});
