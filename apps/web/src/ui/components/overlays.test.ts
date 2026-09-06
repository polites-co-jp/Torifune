import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from './overlays';

/**
 * `ConfirmDialog` に任意の本文を足す（032-timezone-setting 設計 §7.2。実装プラン T15）。
 *
 * 基準タイムゾーンの確認ダイアログは、`message` の 1 行では足りない
 * （消える件数の内訳・Plugin の ID・訪問者数の断り）。
 *
 * **既存の props は変えない。** `children` を渡さないときの HTML は現行のまま。
 * 028 の公開キー再発行（`ui/analytics/settings-tab.tsx`）など、既存の呼び出し元を無修正で通す。
 */

const BASE: ConfirmDialogProps = {
  open: true,
  title: '本当に削除しますか？',
  message: 'この操作で対象が消えます。',
  onConfirm: () => undefined,
  onCancel: () => undefined,
};

function render(overrides: Partial<ConfirmDialogProps> = {}): string {
  return renderToStaticMarkup(createElement(ConfirmDialog, { ...BASE, ...overrides }));
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const IRREVERSIBLE = 'この操作は取り消せません。';

describe('ConfirmDialog の children', () => {
  it('children を渡さないときの HTML は現行のまま', () => {
    const html = render();
    const text = textOf(html);

    expect(text).toContain('この操作で対象が消えます。');
    expect(text).toContain(IRREVERSIBLE);
    expect(text).toContain('キャンセル');
    expect(text).toContain('削除する');
  });

  it('children を渡すと message の下・「この操作は取り消せません。」の上に描く', () => {
    const html = render({
      children: createElement('p', null, '消える集計値：3 サイト / 120 日分'),
    });
    const text = textOf(html);

    const message = text.indexOf('この操作で対象が消えます。');
    const extra = text.indexOf('消える集計値：3 サイト / 120 日分');
    const notice = text.indexOf(IRREVERSIBLE);

    expect(message).toBeGreaterThanOrEqual(0);
    expect(extra).toBeGreaterThan(message);
    expect(notice).toBeGreaterThan(extra);
  });

  it('open が false なら children も描かない', () => {
    const html = render({
      open: false,
      children: createElement('p', null, '消える集計値'),
    });

    expect(html).toBe('');
  });

  /** 確定ボタンの文言は呼び出し側が決められる（既存 props）。 */
  it('confirmLabel を変えられる', () => {
    expect(textOf(render({ confirmLabel: '変更する' }))).toContain('変更する');
  });
});
