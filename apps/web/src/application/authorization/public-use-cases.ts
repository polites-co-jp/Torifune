import { declarePublicUseCase } from './use-case';

/**
 * 認可を必要としない処理の一覧。
 *
 * **ここに足すときは、なぜ認可が要らないのかを必ず書く。**
 * 書けないなら、たいてい認可が要る。
 *
 * この一覧は `authorization-audit.test.ts` が検査する。
 * 意図せず増えたら、テストが落ちて気づける。
 */
export function declarePublicUseCases(): void {
  declarePublicUseCase('auth.login', 'ログイン処理そのもの。認証前に呼ばれる');
  declarePublicUseCase('auth.logout', 'セッションを失効させるだけ。冪等で、他人に害が無い');
  declarePublicUseCase('auth.currentUser', '認証状態を調べる処理そのもの');
  declarePublicUseCase(
    'auth.passwordReset.request',
    '認証前に呼ばれる。登録の有無にかかわらず同じ応答を返すため、情報を漏らさない',
  );
  declarePublicUseCase(
    'auth.passwordReset.confirm',
    '認証前に呼ばれる。トークンの所持が本人性の根拠になる',
  );
  declarePublicUseCase('setup.complete', '管理者が0人のときだけ開く。認可する相手がまだ存在しない');
}
