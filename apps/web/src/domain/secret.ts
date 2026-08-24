/**
 * 平文を持つが、外へ出さない箱。
 *
 * **`JSON.stringify` / `String()` / `console.log` のいずれでも平文が出ない。**
 * 「気をつけて扱う」に頼ると、いつか出る。
 * 取り出すには `expose()` を明示的に呼ぶ必要がある。
 *
 * **Domain 層。暗号方式を知らない。**
 */

const REDACTED = '[REDACTED]';

export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /**
   * 平文を取り出す。
   *
   * **呼び出し箇所は少数に保つこと。** grep でき、レビューできる状態にしておく。
   */
  expose(): string {
    return this.#value;
  }

  /** 値が入っているか。平文を晒さずに判定できる。 */
  get isPresent(): boolean {
    return this.#value !== '';
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  /** `util.inspect`（`console.log`）でも平文を出さない。 */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }

  /** テンプレートリテラルや数値変換でも平文を出さない。 */
  [Symbol.toPrimitive](): string {
    return REDACTED;
  }
}

/** 画面や API へ返す、Secret の「状態」だけの表現。 */
export interface SecretStatus {
  readonly configured: boolean;
}

export function secretStatusOf(secret: Secret | null): SecretStatus {
  return { configured: secret !== null && secret.isPresent };
}
