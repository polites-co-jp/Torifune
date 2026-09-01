-- リダイレクト型認証の State（04_認証設計.md §27）
--
-- 設計: docs/設計/025-redirect-authentication/設計.md §6

-- OIDC 等の外部認証は、認可エンドポイントへの誘導とコールバックという往復で成立する。
-- その往復を結び付けるのが State であり、コールバックの偽造（ログイン CSRF）を防ぐ。
--
-- **Cookie ではなく DB に置く。** 署名付き Cookie では「一度しか使えない」を
-- Core が保証できない（Cookie は利用者が複製できる）。
-- **メモリにも置かない。** 複数プロセスで動かすと、認可開始とコールバックが
-- 別プロセスに当たって往復が成立しなくなる（login_attempts と同じ判断）。
CREATE TABLE auth_authorization_states (
    id           uuid        PRIMARY KEY,
    -- State そのものは保存しない。ハッシュだけ（password_reset_tokens と同じ）。
    state_hash   text        NOT NULL UNIQUE,
    -- nonce は平文で持つ。コールバック時に Plugin へ「元の値」を渡す必要があり、
    -- ハッシュでは ID Token の nonce Claim と照合できない。
    -- **nonce 単体では何の権限も無い**（往復の鍵は state のほう）。
    nonce        text        NOT NULL,
    -- 認可開始を行った Authentication Provider。
    -- コールバックまでの間に差し替わっていたら受け付けない。
    provider_id  text        NOT NULL,
    -- Core が Plugin へ渡した redirect_uri。コールバック時に同じ値かを照合する
    -- （04_認証設計.md §27「Redirect URI検証」）。
    redirect_uri text        NOT NULL,
    -- ログイン後の遷移先。**アプリ内の絶対パスだけ**（Open Redirect 対策）。
    return_to    text        NOT NULL DEFAULT '/',
    expires_at   timestamptz NOT NULL,
    -- 一度使った State を無効にする。使い捨てでなければ、盗まれた State を
    -- 何度でも使える（password_reset_tokens の used_at と同じ考え方）。
    used_at      timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);

-- user_id を持たない。**認可開始の時点では、まだ誰か分かっていない。**

-- 期限切れの掃除に使う。
CREATE INDEX auth_authorization_states_expires_at_idx
    ON auth_authorization_states (expires_at);
