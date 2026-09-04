import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './switch';

/**
 * Switch（028-analytics-dashboard-redesign 設計 §7.4.2、受け入れ条件 #93）。
 *
 * 想定するシグネチャ：
 *
 * ```ts
 * Switch({ checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean })
 * ```
 *
 * * root は `<button role="switch" aria-checked=…>`。hooks を持たない制御コンポーネント
 * * `onClick` は root に置き、ハンドラ内で `disabled` を見て `onChange` を呼ばない（実装プラン §2）
 *
 * DOM イベントが無い Node 環境なので、(a) 静的 HTML の属性、(b) 関数として直接呼んで
 * 返った要素の `props.onClick` を叩く、の 2 つで担保する。
 */

type ClickHandler = (event: unknown) => void;

function rootOnClick(element: ReactElement): ClickHandler | undefined {
  return (element as ReactElement<{ onClick?: ClickHandler }>).props.onClick;
}

/** ハンドラが `event.preventDefault()` 等を呼んでも落ちないための最小のイベント。 */
const clickEvent = { preventDefault: () => {}, stopPropagation: () => {} };

describe('Switch', () => {
  it('role="switch" を持つ', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { checked: false, onChange: () => {}, label: 'Bot を集計に含める' }),
    );
    expect(html).toContain('role="switch"');
  });

  it('checked のとき aria-checked="true" になる', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { checked: true, onChange: () => {}, label: 'Bot を集計に含める' }),
    );
    expect(html).toContain('aria-checked="true"');
  });

  it('checked でないとき aria-checked="false" になる', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { checked: false, onChange: () => {}, label: 'Bot を集計に含める' }),
    );
    expect(html).toContain('aria-checked="false"');
  });

  it('label が読み上げに出る', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { checked: false, onChange: () => {}, label: 'Bot を集計に含める' }),
    );
    expect(html).toContain('Bot を集計に含める');
  });

  it('disabled のとき disabled 属性が付く', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, {
        checked: false,
        onChange: () => {},
        label: 'Bot を集計に含める',
        disabled: true,
      }),
    );
    expect(html).toMatch(/\sdisabled(=""|\s|>)/);
  });

  it('disabled でなければ disabled 属性が付かない', () => {
    const html = renderToStaticMarkup(
      createElement(Switch, { checked: false, onChange: () => {}, label: 'Bot を集計に含める' }),
    );
    expect(html).not.toMatch(/\sdisabled(=""|\s|>)/);
  });

  it('disabled のときクリックしても onChange が呼ばれない', () => {
    const onChange = vi.fn();
    const element = Switch({
      checked: false,
      onChange,
      label: 'Bot を集計に含める',
      disabled: true,
    }) as ReactElement;

    rootOnClick(element)?.(clickEvent);

    expect(onChange).not.toHaveBeenCalled();
  });

  it('有効ならクリックで onChange が反転した値で呼ばれる', () => {
    const onChange = vi.fn();
    const element = Switch({
      checked: false,
      onChange,
      label: 'Bot を集計に含める',
    }) as ReactElement;

    const onClick = rootOnClick(element);
    expect(onClick, 'root 要素に onClick が無い').toBeTypeOf('function');
    onClick?.(clickEvent);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('有効で checked ならクリックで onChange(false) になる', () => {
    const onChange = vi.fn();
    const element = Switch({
      checked: true,
      onChange,
      label: 'Bot を集計に含める',
    }) as ReactElement;

    rootOnClick(element)?.(clickEvent);

    expect(onChange).toHaveBeenCalledWith(false);
  });
});
