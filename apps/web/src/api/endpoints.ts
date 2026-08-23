/**
 * すべてのエンドポイントを読み込む。
 *
 * `defineRoute` の副作用で登録されるため、OpenAPI を生成する前に
 * 各ルートモジュールが評価されている必要がある。
 * Next.js は要求されたルートしか読み込まないので、ここでまとめて import する。
 */
import '@/app/api/v1/auth/csrf/route';
import '@/app/api/v1/auth/login/route';
import '@/app/api/v1/auth/logout/route';
import '@/app/api/v1/auth/me/route';
import '@/app/api/v1/auth/password-reset/confirm/route';
import '@/app/api/v1/auth/password-reset/request/route';
import '@/app/api/v1/permissions/route';
import '@/app/api/v1/roles/route';
import '@/app/api/v1/setup/route';
import '@/app/api/v1/sites/route';
import '@/app/api/v1/sites/[id]/route';
import '@/app/api/v1/social/accounts/route';
import '@/app/api/v1/social/accounts/[id]/route';
import '@/app/api/v1/social/posts/route';
import '@/app/api/v1/social/posts/[id]/route';

export {};
