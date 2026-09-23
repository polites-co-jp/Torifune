import type { AccountStatus } from '@/domain/social/social';
import {
  CREDENTIAL_ALL_FIELDS_REQUIRED,
  CREDENTIAL_NONE_NOTE,
  CREDENTIAL_REQUIRED,
} from '@/ui/social/labels';
// 型だけを引く。'use client' のモジュールの値を純関数の側へ引き込まない（039 実装プラン T1）。
import type { ProviderCredentialField, ProviderOption } from '@/ui/social/social-accounts';

/**
 * 資格情報の入力の形と、画面が送る本文（039-social-credential-fields 設計 §7.1 / §7.2 / §7.7）。
 *
 * **判定と本文の組み立てを純関数に出す。** 単体テストの環境には DOM が無く、Modal のボタンを
 * 押して送信の中身を見られない（設計 §4）。
 *
 * * `fields`：publisher が登録されていて `credentialFields` が空でない → 項目ごとの欄
 * * `none`：publisher が登録されていて `credentialFields` が空 → 欄を出さない
 * * `free`：publisher が登録されていない → 汎用の欄 1 つ（設計 §7.1.1 で残す）
 */
export type CredentialInput = 'fields' | 'none' | 'free';

/**
 * provider の入力の形。option が無い（一覧に無い provider）ときは `'free'`。
 *
 * **`publisherRegistered` の省略は `false` と読む**（後方互換。既存の `ProviderOption` は
 * いままでどおり汎用の欄の意味のまま）。
 */
export function credentialInputOf(option: ProviderOption | undefined): CredentialInput {
  if (option === undefined) return 'free';
  if (option.credentialFields.length > 0) return 'fields';
  if (option.publisherRegistered === true) return 'none';
  return 'free';
}

/** 入れ直しの本文（設計 §6）。 */
export type SetCredentialRequest =
  | { readonly credentials: Record<string, string>; readonly status: 'connected' }
  | { readonly credential: string; readonly status: 'connected' };

export type SetCredentialResult =
  | { readonly ok: true; readonly body: SetCredentialRequest }
  | { readonly ok: false; readonly message: string };

/** 消去の本文（設計 §6）。 */
export interface ClearCredentialRequest {
  readonly credentials: Record<string, never>;
  readonly status?: 'disconnected';
}

/** アカウント追加の本文のうち資格情報と状態（設計 §7.2）。 */
export interface CreateCredentialRequest {
  readonly credential?: string;
  readonly credentials?: Record<string, string>;
  readonly status: AccountStatus;
}

/**
 * アカウント追加の本文のうち資格情報と状態（設計 §7.2）。
 *
 * * `none`：資格情報を**送らない**。要らない provider では追加した時点で揃っているので `connected`
 * * `fields`：入れた項目だけの `credentials`。0 項目でも `credentials: {}` のキーを持つ（035 からの送り方）
 * * `free`：`credential`。空でも `credential: ''` のキーを持つ（同上）
 *
 * 宣言に無いキー（「サービス」を切り替える前の入力の残り）は送らない。
 */
export function createCredentialBody(
  input: CredentialInput,
  fields: readonly ProviderCredentialField[],
  values: Readonly<Record<string, string>>,
  credential: string,
): CreateCredentialRequest {
  if (input === 'none') {
    return { status: 'connected' };
  }
  if (input === 'fields') {
    const filled: Record<string, string> = {};
    for (const field of fields) {
      const value = values[field.key] ?? '';
      if (value !== '') filled[field.key] = value;
    }
    return {
      credentials: filled,
      status: Object.keys(filled).length > 0 ? 'connected' : 'disconnected',
    };
  }
  return { credential, status: credential !== '' ? 'connected' : 'disconnected' };
}

/**
 * 入れ直しの本文（設計 §6・§7.3.3）。未入力があれば要求を作らない。`none` は常に `ok: false`。
 *
 * * `fields`：**宣言のキーちょうど**で、全項目が要る（保存は丸ごと置き換え。035 §5.7）
 * * `free`：自由文字列 1 つ
 * * 空とみなすのは長さ 0 だけ（空白だけの値は送る。正はサーバ）
 */
export function setCredentialBody(
  input: CredentialInput,
  fields: readonly ProviderCredentialField[],
  values: Readonly<Record<string, string>>,
  credential: string,
): SetCredentialResult {
  if (input === 'none') {
    return { ok: false, message: CREDENTIAL_NONE_NOTE };
  }
  if (input === 'free') {
    if (credential === '') return { ok: false, message: CREDENTIAL_REQUIRED };
    return { ok: true, body: { credential, status: 'connected' } };
  }

  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (value === '') return { ok: false, message: CREDENTIAL_ALL_FIELDS_REQUIRED };
    credentials[field.key] = value;
  }
  if (Object.keys(credentials).length === 0) {
    // 宣言が空の `fields` は判定の上では起きない。送れば消去になるので要求を作らない。
    return { ok: false, message: CREDENTIAL_ALL_FIELDS_REQUIRED };
  }
  return { ok: true, body: { credentials, status: 'connected' } };
}

/**
 * 消去の本文（設計 §6・§7.4）。
 *
 * `none` は `status` を送らない。その provider では資格情報の有無が配信の支度に関わらない。
 */
export function clearCredentialBody(input: CredentialInput): ClearCredentialRequest {
  if (input === 'none') {
    return { credentials: {} };
  }
  return { credentials: {}, status: 'disconnected' };
}

/* -------------------------------------------------------------------------- */
/* 部品が送る本文（providers・対象・入力値 → 本文。設計 §7.7.1）                  */
/* -------------------------------------------------------------------------- */

/**
 * provider の入力の形と、その形で使う項目。
 *
 * **入力の形を決めるところから本文までを 1 つの純関数にまとめる**（設計 §7.7.1）。
 * 部品で入力の形を決めると、`none` を `free` 扱いにする変異がどの層でも固定されない。
 * 選択肢に無い provider は `free`（設計 §7.1）。
 */
function credentialShapeOf(
  providers: readonly ProviderOption[],
  provider: string,
): { readonly input: CredentialInput; readonly fields: readonly ProviderCredentialField[] } {
  const option = providers.find((candidate) => candidate.value === provider);
  const input = credentialInputOf(option);
  return {
    input,
    fields: input === 'fields' && option !== undefined ? option.credentialFields : [],
  };
}

/** アカウント追加の要求の本文（`POST /api/v1/social/accounts`）。 */
export interface CreateAccountRequest extends CreateCredentialRequest {
  readonly provider: string;
  readonly displayName: string;
  readonly handle: string;
}

/**
 * アカウント追加の要求の本文（設計 §7.2 / §7.7.1）。選んだ provider の入力の形を `providers` から決める。
 *
 * `displayName` / `handle` は加工しない（整えるのはサーバの UseCase）。
 */
export function buildCreateAccountRequest(
  providers: readonly ProviderOption[],
  input: {
    readonly provider: string;
    readonly displayName: string;
    readonly handle: string;
    readonly values: Readonly<Record<string, string>>;
    readonly credential: string;
  },
): CreateAccountRequest {
  const shape = credentialShapeOf(providers, input.provider);
  return {
    provider: input.provider,
    displayName: input.displayName,
    handle: input.handle,
    ...createCredentialBody(shape.input, shape.fields, input.values, input.credential),
  };
}

/** 入れ直しの要求（`PATCH`。設計 §6・§7.3.3・§7.7.1）。`account.provider` の入力の形を `providers` から決める。 */
export function buildSetCredentialRequest(
  providers: readonly ProviderOption[],
  account: { readonly provider: string },
  values: Readonly<Record<string, string>>,
  credential: string,
): SetCredentialResult {
  const shape = credentialShapeOf(providers, account.provider);
  return setCredentialBody(shape.input, shape.fields, values, credential);
}

/** 消去の要求（`PATCH`。設計 §6・§7.4・§7.7.1）。 */
export function buildClearCredentialRequest(
  providers: readonly ProviderOption[],
  account: { readonly provider: string },
): ClearCredentialRequest {
  return clearCredentialBody(credentialShapeOf(providers, account.provider).input);
}
