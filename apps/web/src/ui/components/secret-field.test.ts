import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SecretField, type SecretFieldProps } from './overlays';

/**
 * `SecretField` の省略できる `description`（039-social-credential-fields 設計 §7.1.2、
 * 受け入れ条件 #47、#48）。
 *
 * * 渡したときは、ラベルの下・入力の上に説明を出し、`aria-describedby` で入力と結ぶ
 * * **省略したときの HTML は現行と同じ**（既存の呼び出し元の見た目を変えない）。
 *   `description: ''` も「無い」として扱う（空の要素や空の参照を残さない）
 * * 文字列はテキストとして描く（HTML として解釈しない）
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

  it('#47 ラベルと type="password" の入力は現行どおり出る', () => {
    const html = render({ placeholder: '保存後は再表示されません' });

    expect(html).toContain(LABEL);
    expect(passwordInput(html)).toContain('placeholder="保存後は再表示されません"');
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
