/** テナント内ではなくインスタンス全体のロール。**Domain 層。** */
export interface Role {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  /** 標準で用意するロール。削除・改名を許さない。 */
  readonly isSystem: boolean;
}
