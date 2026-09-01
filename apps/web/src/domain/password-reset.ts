/**
 * パスワードリセットの決まりごと（04_認証設計.md §24）。
 *
 * 有効期限を Domain 層へ置くのは、**リセットURLを作る側（Infrastructure）と
 * トークンを発行する側（Application）の両方が同じ値を要る**ため。
 * どちらかに置くともう片方が層をまたいで引きに行くことになる。
 */

/** リセットトークンの有効期限。短くしすぎると使えず、長すぎると盗まれたときに危ない。 */
export const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

/** 利用者へ伝えるための時間数。 */
export const RESET_TOKEN_LIFETIME_HOURS = Math.round(RESET_TOKEN_LIFETIME_MS / (60 * 60 * 1000));
