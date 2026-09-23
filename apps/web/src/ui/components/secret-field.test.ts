import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretField, type SecretFieldProps } from './overlays';

/**
 * `SecretField` の省略できる `description` と `autocomplete`（039-social-credential-fields 設計
 * §7.1.2 / §7.1.3、受け入れ条件 #47、#48、#73）。
 *
 * * 渡したときは、ラベルの下・入力の上に説明を出し、`aria-describedby` で入力と結ぶ
 * * **省略したときの HTML は 039 より前の版と `autocomplete` の値の 1 か所を除いて同じ**
 *   （既存の呼び出し元の見た目を変えない）。
 *   `description: ''` も「無い」として扱う（空の要素や空の参照を残さない）
 * * 文字列はテキストとして描く（HTML として解釈しない）
 * * password の入力は説明の有無の両方で `autocomplete="new-password"`
 *   （ログインのパスワードの自動入力と、入れたトークンのブラウザへの保存を避ける）
 *
 * `useId` の値は決め打ちしない（実装プラン §2「aria-describedby の検査」）。
 * HTML の文字列から「説明の文字列を持つ要素の `id`」を取り出し、入力の
 * `aria-describedby`（空白区切り）にその `id` が含まれることを見る。
 *
 * 見るのは入力のある枝（`configured={false}`）だけ。設定済みの枝（「••••」＋「変更する」）は
 * 本件で使わず、変えない（実装プラン §8 の 6）。
 */

const LABEL = 'アクセストークン';
const DESCRIPTION = '発行した値を入れます';
const PLACEHOLDER = '保存後は再表示されません';

/**
 * 039 より前の版（コミット 20498ff の親）の `SecretField` を `label: LABEL` / `configured: false` /
 * `placeholder: PLACEHOLDER` で `renderToStaticMarkup` した HTML（設計 #47。2026-09-23 に書き換え）。
 * **手で書き換えない。** 読みやすさのため区切って連結しているだけで、中身は描いた文字列そのもの。
 */
const PRE_039_HTML = [
  '<div style="margin-bottom:var(--tf-space-4)">',
  '<label style="display:block;margin-bottom:var(--tf-space-1)">',
  'アクセストークン',
  '<input type="password" autoComplete="off" placeholder="保存後は再表示されません" ',
  'style="width:100%;height:var(--tf-size-input);padding:var(--tf-space-2) var(--tf-space-4);',
  'border:1px solid var(--tf-color-border);border-radius:var(--tf-radius-lg);font:inherit;',
  'margin-top:var(--tf-space-1)"/>',
  '</label>',
  '</div>',
].join('');
const PRE_039_AUTOCOMPLETE = 'autoComplete="off"';
const NEW_AUTOCOMPLETE = 'autoComplete="new-password"';

const BASE: SecretFieldProps = {
  label: LABEL,
  configured: false,
  onChange: () => undefined,
};

function render(overrides: Partial<SecretFieldProps> = {}): string {
  return renderToStaticMarkup(createElement(SecretField, { ...BASE, ...overrides }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 中身の文字列がちょうど `text` の要素の `id`。無ければ null。 */
function idOfElementWithText(html: string, text: string): string | null {
  const pattern = new RegExp(`<(\\w+)\\s[^>]*?\\bid="([^"]+)"[^>]*>${escapeRegExp(text)}</\\1>`);
  return pattern.exec(html)?.[2] ?? null;
}

function passwordInput(html: string): string {
  const input = /<input[^>]*type="password"[^>]*>/.exec(html)?.[0];
  if (input === undefined) throw new Error('type="password" の入力が無い');
  return input;
}

function attributeOf(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

describe('SecretField の description を渡さないとき', () => {
  it('#47 入力に aria-describedby 属性が無い', () => {
    expect(passwordInput(render())).not.toContain('aria-describedby');
  });

  it('#47 HTML のどこにも aria-describedby 属性が無い', () => {
    expect(render()).not.toContain('aria-describedby');
  });

  it('#47 説明の要素（<p>）を描かない', () => {
    expect(render()).not.toMatch(/<p[\s>]/);
  });

  it("#47 description: '' でも aria-describedby も説明の要素も無い", () => {
    const html = render({ description: '' });

    expect(html).not.toContain('aria-describedby');
    expect(html).not.toMatch(/<p[\s>]/);
  });

  it("#47 description: '' の HTML は省略したときと同じ", () => {
    expect(render({ description: '' })).toBe(render());
  });

  it('#47 039 より前の版の HTML と autocomplete の値の 1 か所を除いて完全に一致する', () => {
    // 期待値は 039 より前の版（コミット 20498ff の親の `ui/components/overlays.tsx`）の `SecretField` を
    // 同じ props で一度だけ描いて貼ったもの（実装プラン §8 の 29。実行時に git を呼ばない）。
    // `autocomplete` だけは設計 §7.1.3 で `off` → `new-password` に変えた。
    expect(
      PRE_039_HTML.split(PRE_039_AUTOCOMPLETE).length - 1,
      '貼った期待値に autocomplete="off" がちょうど 1 か所ない（置き換えが空振りする）',
    ).toBe(1);

    expect(render({ placeholder: PLACEHOLDER })).toBe(
      PRE_039_HTML.replace(PRE_039_AUTOCOMPLETE, NEW_AUTOCOMPLETE),
    );
  });
});

describe('SecretField の autocomplete（設計 §7.1.3）', () => {
  /** 属性名は大文字小文字を区別しない（HTML の属性名。React は `autoComplete` のまま書き出す）。 */
  function autocompleteOf(input: string): string | null {
    return /\sautocomplete="([^"]*)"/i.exec(input)?.[1] ?? null;
  }

  it('#73 description を渡さないとき、type="password" の入力が autocomplete="new-password" を持つ', () => {
    expect(autocompleteOf(passwordInput(render()))).toBe('new-password');
  });

  it('#73 description を渡したとき、type="password" の入力が autocomplete="new-password" を持つ', () => {
    expect(autocompleteOf(passwordInput(render({ description: DESCRIPTION })))).toBe(
      'new-password',
    );
  });

  it('#73 description の有無のどちらでも autocomplete="off" を持たない', () => {
    for (const html of [render(), render({ description: DESCRIPTION })]) {
      expect(html).not.toMatch(/\sautocomplete="off"/i);
    }
  });
});

describe('SecretField に description を渡したとき', () => {
  it('#48 説明の文字列が描かれる', () => {
    expect(render({ description: DESCRIPTION })).toContain(DESCRIPTION);
  });

  it('#48 説明の文字列を持つ要素に id がある', () => {
    expect(idOfElementWithText(render({ description: DESCRIPTION }), DESCRIPTION)).not.toBeNull();
  });

  it('#48 type="password" の入力の aria-describedby が説明の要素の id を指す', () => {
    const html = render({ description: DESCRIPTION });
    const descriptionId = idOfElementWithText(html, DESCRIPTION);
    const describedBy = attributeOf(passwordInput(html), 'aria-describedby');

    expect(descriptionId).not.toBeNull();
    expect((describedBy ?? '').split(/\s+/)).toContain(descriptionId);
  });

  it('#48 説明はラベルの後・入力の前に並ぶ', () => {
    const html = render({ description: DESCRIPTION });

    const label = html.indexOf(LABEL);
    const description = html.indexOf(DESCRIPTION);
    const input = html.indexOf(passwordInput(html));

    expect(label).toBeGreaterThanOrEqual(0);
    expect(label).toBeLessThan(description);
    expect(description).toBeLessThan(input);
  });

  it('#48 説明はラベルの中に入らない（入力のアクセシブルな名前に説明が混ざらない）', () => {
    const html = render({ description: DESCRIPTION });
    const labels = [...html.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((match) => match[1]);

    expect(labels.length).toBeGreaterThan(0);
    for (const inner of labels) {
      expect(inner).not.toContain(DESCRIPTION);
    }
  });

  it('#48 ラベルは入力と結ばれている（label の for が入力の id）', () => {
    const html = render({ description: DESCRIPTION });
    const labelTag = /<label[^>]*>/.exec(html)?.[0] ?? '';
    const inputId = attributeOf(passwordInput(html), 'id');

    expect(inputId).not.toBeNull();
    expect(attributeOf(labelTag, 'for')).toBe(inputId);
  });

  it('#48 説明の HTML はテキストとして描かれる（エスケープされる）', () => {
    const html = render({ description: '<b>強調</b>' });

    expect(html).toContain('&lt;b&gt;強調&lt;/b&gt;');
    expect(html).not.toContain('<b>');
  });
});
