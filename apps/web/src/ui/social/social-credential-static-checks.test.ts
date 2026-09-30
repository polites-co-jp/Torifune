import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 資格情報の入れ直しの文言を部品に直書きしない（039-social-credential-fields 設計 §7.8、
 * 受け入れ条件 #46）。部品が送る本文を `build…Request` だけで組む（設計 §7.7.1、#74。ファイルの後半）。
 *
 * 文言は `labels.ts` に置く（`labels.ts` の冒頭の方針。`02_画面デザイン方針.md` §5）。
 * `social-accounts.tsx` のソースに、下の文言が**文字列リテラルまたは JSX のテキストとして**現れないこと、
 * `labels.ts` に同じ文言があること（検査が空振りしていない証明）を見る。
 *
 * * **コメントの中の文言は数えない**（コメントを外してから見る）
 * * 「消す」のような短い語は、引用符で囲まれた形か JSX のテキストちょうどの形でだけ見る
 *   （「資格情報を消す」の部分文字列に反応させない）
 */

const DIR = import.meta.dirname;

function source(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

/** 設計 §7.8 の文言（§7.2 / §7.3.2 の説明文と警告文、§7.3.2 の対象、§7.4 の確認の本文を含む）。 */
const WORDS = [
  '資格情報を設定',
  '現在の状態：設定済み',
  '現在の状態：未設定',
  '資格情報を消す',
  '資格情報を消しますか？',
  '資格情報を保存しました。',
  '資格情報を消しました。',
  'すべての項目を入力してください。',
  '資格情報を入力してください。',
  // §7.2 / §7.3.2 の none の説明
  'この SNS の配信 Plugin は資格情報を使いません。入力は要りません。',
  // §7.3.2 の fields の説明
  '保存済みの値は表示しません。保存すると、保存済みの資格情報はすべてここで入力した値に置き換わります（一部の項目だけを変えることはできません）。',
  // §7.3.2 の free の説明
  'この SNS の配信 Plugin が有効になっていないため、入力した値を形式を確かめずにそのまま保存します。配信 Plugin を有効にした後は、その Plugin の項目で入れ直してください。',
  // §7.3.2 の none で設定済みのときの警告
  '保存済みの資格情報がありますが、いまの配信 Plugin では使われません。',
  '同じ SNS の別の配信 Plugin に入れ替えるとその Plugin が読み、形式が合わなければ自動配信が失敗します。不要なら消してください。',
  // §7.3.2 の対象の行（表示名とサービスの表示名を受ける）
  '対象：',
  // §7.4 の確認の本文（表示名を受ける）
  'の保存済みの資格情報を消します。消した値は元に戻せません。',
] as const;

/** 部分文字列で見ると誤って当たる短い語（確認ダイアログの確定のボタン）。 */
const SHORT_WORDS = ['消す'] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `/* … *\/`（JSX の `{/* … *\/}` を含む）と `// …` を外す。`https://` のような `:` の後は外さない。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 文言が文字列リテラルか JSX のテキストとして現れるか。 */
function isHardCoded(text: string, word: string): boolean {
  return stripComments(text).includes(word);
}

/** 短い語が、引用符で囲まれた形か JSX のテキストちょうどの形で現れるか。 */
function isHardCodedShort(text: string, word: string): boolean {
  const escaped = escapeRegExp(word);
  const quoted = new RegExp(`(['"\`])${escaped}\\1`);
  const jsxText = new RegExp(`>\\s*${escaped}\\s*<`);
  const code = stripComments(text);
  return quoted.test(code) || jsxText.test(code);
}

describe('#46 social-accounts.tsx に §7.8 の文言を直書きしない', () => {
  const component = source('social-accounts.tsx');

  it.each(WORDS)('#46 「%s」を直書きしない', (word) => {
    expect(isHardCoded(component, word)).toBe(false);
  });

  it.each(SHORT_WORDS)('#46 「%s」を引用符や JSX のテキストで直書きしない', (word) => {
    expect(isHardCodedShort(component, word)).toBe(false);
  });
});

describe('#46 文言は labels.ts にある（検査が空振りしていない）', () => {
  const labels = source('labels.ts');

  it.each(WORDS)('#46 labels.ts に「%s」がある', (word) => {
    expect(isHardCoded(labels, word)).toBe(true);
  });

  it.each(SHORT_WORDS)('#46 labels.ts に「%s」が文字列として現れる', (word) => {
    expect(isHardCodedShort(labels, word)).toBe(true);
  });
});

describe('#46 検査の述語の判別力', () => {
  it('#46 JSX のテキストに直書きした写しを見分ける', () => {
    expect(isHardCoded('<Button variant="ghost">資格情報を設定</Button>', '資格情報を設定')).toBe(
      true,
    );
  });

  it('#46 文字列リテラルに直書きした写しを見分ける', () => {
    expect(
      isHardCoded("setToast({ text: '資格情報を保存しました。' });", '資格情報を保存しました。'),
    ).toBe(true);
  });

  it('#46 テンプレートリテラルに埋めた写しを見分ける', () => {
    expect(isHardCoded('const line = `対象：${name}（${label}）`;', '対象：')).toBe(true);
  });

  it('#46 コメントの中の文言は数えない', () => {
    const text = [
      '// 「資格情報を設定」を押したら開く',
      '{/* 「資格情報を消す」は設定済みのときだけ */}',
      '/** 資格情報を保存しました。 */',
      '<Button>{CREDENTIAL_SET_LABEL}</Button>',
    ].join('\n');

    expect(isHardCoded(text, '資格情報を設定')).toBe(false);
    expect(isHardCoded(text, '資格情報を消す')).toBe(false);
    expect(isHardCoded(text, '資格情報を保存しました。')).toBe(false);
  });

  it('#46 短い語は引用符で囲んだ写しを見分ける', () => {
    expect(isHardCodedShort('<ConfirmDialog confirmLabel="消す" />', '消す')).toBe(true);
    expect(isHardCodedShort("confirmLabel={'消す'}", '消す')).toBe(true);
  });

  it('#46 短い語は JSX のテキストちょうどの写しを見分ける', () => {
    expect(isHardCodedShort('<Button>\n  消す\n</Button>', '消す')).toBe(true);
  });

  it('#46 短い語は長い文言の部分文字列に反応しない', () => {
    expect(isHardCodedShort('<Button>{CLEAR}</Button> // 資格情報を消す', '消す')).toBe(false);
    expect(isHardCodedShort("const label = '資格情報を消す';", '消す')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* #74 部品が送る本文は 3 つの build…Request だけで組む（設計 §7.7.1）            */
/* -------------------------------------------------------------------------- */

/**
 * 部品（`social-accounts.tsx`）の `submitCreate` / `submitEdit` / `confirmClear` は、
 * `apiRequest` の `body` に `build…Request` の戻り値だけを渡す。入力の形の判断を部品に置かない
 * （部品で `none` を `free` 扱いにする・消去の形を `fields` に固定する、という変異を単体で落とせるようにする）。
 *
 * 呼び出しは「名前の直後（空白を挟んでよい）に `(`」で数える。import の並びや型の参照は数えない。
 * コメントの中は数えない。
 */

/** 部品の中で直接呼んではならない（本文の形を部品で決めることになる）。 */
const LOW_LEVEL_BUILDERS = [
  'createCredentialBody',
  'setCredentialBody',
  'clearCredentialBody',
] as const;

/** 部品が本文を組むのに使う（それぞれ 1 回以上呼ぶ）。 */
const REQUEST_BUILDERS = [
  'buildCreateAccountRequest',
  'buildSetCredentialRequest',
  'buildClearCredentialRequest',
] as const;

/** `name(` の呼び出しの回数（コメントを外して数える。`fooname(` のような別名の一部には当てない）。 */
function callCount(text: string, name: string): number {
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`, 'g');
  return [...stripComments(text).matchAll(pattern)].length;
}

describe('#74 social-accounts.tsx は本文を build…Request で組む', () => {
  const component = source('social-accounts.tsx');

  it.each(LOW_LEVEL_BUILDERS)('#74 %s( を呼ばない', (name) => {
    expect(callCount(component, name)).toBe(0);
  });

  it.each(REQUEST_BUILDERS)('#74 %s( を 1 つ以上呼ぶ', (name) => {
    expect(callCount(component, name)).toBeGreaterThanOrEqual(1);
  });
});

describe('#74 検査の述語の判別力', () => {
  it('#74 本文の関数を直接呼ぶ写しを見分ける', () => {
    const text = [
      "const body = createCredentialBody(credentialInputOf(optionOf(provider)), fields, values, '');",
      'const result = setCredentialBody (input, fields, values, credential);',
      "const clear = clearCredentialBody('fields');",
    ].join('\n');

    for (const name of LOW_LEVEL_BUILDERS) {
      expect(callCount(text, name), name).toBe(1);
    }
  });

  it('#74 build…Request の呼び出しを数える', () => {
    const text = [
      'body: buildCreateAccountRequest(props.providers, { provider, displayName, handle, values, credential }),',
      'const result = buildSetCredentialRequest(props.providers, account, values, credential);',
      'body: buildClearCredentialRequest(props.providers, account),',
    ].join('\n');

    for (const name of REQUEST_BUILDERS) {
      expect(callCount(text, name), name).toBe(1);
    }
  });

  it('#74 import の並び・型の参照・コメントの中は呼び出しに数えない', () => {
    const text = [
      'import { createCredentialBody, setCredentialBody } from "./credential-form";',
      'type Body = ReturnType<typeof clearCredentialBody>;',
      '// createCredentialBody(…) は使わない',
      '/* setCredentialBody(…) */',
    ].join('\n');

    for (const name of LOW_LEVEL_BUILDERS) {
      expect(callCount(text, name), name).toBe(0);
    }
  });

  it('#74 build…Request の名前の一部（setCredentialBody を含まない）に反応しない', () => {
    // `buildSetCredentialRequest(` は `setCredentialBody(` を含まない。別名の一部にも当てない。
    expect(callCount('buildSetCredentialRequest(a, b, c, d)', 'setCredentialBody')).toBe(0);
    expect(callCount('mySetCredentialBody(a)', 'setCredentialBody')).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* #74 build…Request の第 1 引数は props.providers ちょうど（2026-09-24 に追加）   */
/* -------------------------------------------------------------------------- */

/**
 * 呼び出しの回数だけでは、部品が書き換えた選択肢を渡す変異
 * （`buildClearCredentialRequest(props.providers.map((o) => ({ ...o, publisherRegistered: false })), …)`。
 * `none` が `free` として送られる）を見逃す（039 の検証 2 回目 軽微-2）。
 * 設計 §7.7.1 の「第 1 引数には部品の props の `providers` を `props.providers` のまま渡す」を、
 * すべての `build…Request(` の呼び出しの第 1 引数の字面で見る。
 */

/** 第 1 引数に許す字面（部品の props の選択肢そのもの）。 */
const PROVIDERS_ARGUMENT = 'props.providers';

/**
 * `name(` の各呼び出しの第 1 引数の字面（前後の空白を除く）。コメントを外してから見る。
 * 括弧（`()` / `[]` / `{}`）の入れ子と文字列リテラルの中の `,` / `)` は区切りにしない。
 */
function firstArguments(text: string, name: string): string[] {
  const code = stripComments(text);
  const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}\\s*\\(`, 'g');
  const found: string[] = [];

  for (const match of code.matchAll(pattern)) {
    let depth = 0;
    let quote: string | null = null;
    let index = (match.index ?? 0) + match[0].length;
    const start = index;

    for (; index < code.length; index += 1) {
      const char = code[index] as string;
      if (quote !== null) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (char === ',' && depth === 0) break;
    }
    found.push(code.slice(start, index).trim());
  }

  return found;
}

describe('#74 social-accounts.tsx の build…Request の第 1 引数は props.providers ちょうど', () => {
  const component = source('social-accounts.tsx');

  it.each(REQUEST_BUILDERS)('#74 %s( のすべての呼び出しの第 1 引数が props.providers', (name) => {
    const args = firstArguments(component, name);

    expect(args.length).toBeGreaterThanOrEqual(1);
    expect(args).toEqual(args.map(() => PROVIDERS_ARGUMENT));
  });
});

describe('#74 第 1 引数の検査の判別力', () => {
  const component = source('social-accounts.tsx');

  /** 書き換えた一覧。`publisherRegistered` を偽にすると `none` が `free` になる。 */
  const REWRITTEN = 'props.providers.map((o) => ({ ...o, publisherRegistered: false }))';

  it.each(REQUEST_BUILDERS)(
    '#74 実物の %s( の第 1 引数を書き換えた写しを、回数の検査は通し、第 1 引数の検査は落とす',
    (name) => {
      const original = `${name}(${PROVIDERS_ARGUMENT}`;
      // 前提：実物に書き換える箇所がある（空振りしない）。
      expect(component).toContain(original);
      const mutated = component.replace(original, `${name}(${REWRITTEN}`);

      // 回数の検査だけでは見逃す（直す前の #74 の穴）。
      expect(callCount(mutated, name)).toBeGreaterThanOrEqual(1);
      // 第 1 引数の検査は見分ける。
      expect(firstArguments(mutated, name)).toContain(REWRITTEN);
      expect(firstArguments(mutated, name).every((arg) => arg === PROVIDERS_ARGUMENT)).toBe(false);
    },
  );

  it('#74 別の変数に移した一覧を渡す写しを見分ける', () => {
    const text = [
      'const providers = props.providers.filter((o) => o.publisherRegistered);',
      'body: buildClearCredentialRequest(providers, target),',
    ].join('\n');

    expect(firstArguments(text, 'buildClearCredentialRequest')).toEqual(['providers']);
  });

  it('#74 第 1 引数の区切りは入れ子の括弧・文字列の中の , と ) を数えない', () => {
    const text = [
      "buildSetCredentialRequest(pick(props.providers, 'a,b)'), target, values, '')",
      'buildCreateAccountRequest(props.providers, { provider, values: { a: 1, b: 2 } })',
      '// buildClearCredentialRequest(rewritten, target)',
    ].join('\n');

    expect(firstArguments(text, 'buildSetCredentialRequest')).toEqual([
      "pick(props.providers, 'a,b)')",
    ]);
    expect(firstArguments(text, 'buildCreateAccountRequest')).toEqual([PROVIDERS_ARGUMENT]);
    expect(firstArguments(text, 'buildClearCredentialRequest')).toEqual([]);
  });
});
