import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 資格情報の入れ直しの文言を部品に直書きしない（039-social-credential-fields 設計 §7.8、
 * 受け入れ条件 #46）。
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
