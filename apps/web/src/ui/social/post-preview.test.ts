import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { POST_BODY_MAX_LENGTH } from '@/domain/social/social';
import * as labels from './labels';

/**
 * 本文の全文の表示（056-social-row-layout 設計 §5.3、受け入れ条件 #6〜#9。ユーザー裁定 4・5）。
 *
 * * #6 `tf-visually-hidden` の「本文」の後に、`white-space: pre-wrap`・`overflow-wrap: anywhere` を持つ要素があり、
 *   その中が本文そのまま（改行・連続した空白・前後の空白を変えない。HTML のエスケープだけ）
 * * #7 10,000 字（`POST_BODY_MAX_LENGTH`）の本文が切られず全文で入り、「…」を足さない
 * * #8 本文の要素に `-webkit-line-clamp`・`overflow: hidden`・`max-height` が無い（省略しない）
 * * #9 `POST_BODY_PREVIEW_LABEL` が「本文」で `labels.ts` から export される
 *
 * `post-preview.tsx` はまだ無いので、指定子を `string` の定数に置いた動的 import で読み、props の型（`body` だけ。
 * 056 実装プラン §8 の 3）をテストに写して `as` で渡す。`POST_BODY_PREVIEW_LABEL` も未実装の export なので
 * 名前空間の import から文字列のキーで読む（型検査を未実装の export に掛けない）。
 */

interface PostBodyPreviewProps {
  readonly body: string;
}

const MODULE: string = '@/ui/social/post-preview';

async function loadComponent(): Promise<ComponentType<PostBodyPreviewProps>> {
  const module = (await import(/* @vite-ignore */ MODULE)) as Record<string, unknown>;
  const component = module['PostBodyPreview'];
  if (typeof component !== 'function') {
    throw new Error('ui/social/post-preview.tsx に PostBodyPreview が無い');
  }
  return component as ComponentType<PostBodyPreviewProps>;
}

async function render(body: string): Promise<string> {
  const PostBodyPreview = await loadComponent();
  return renderToStaticMarkup(createElement(PostBodyPreview, { body }));
}

const HIDDEN_LABEL = '本文';

/* -------------------------------------------------------------------------- */
/* HTML の読み方                                                                 */
/* -------------------------------------------------------------------------- */

function unescapeHtml(html: string): string {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function styleOf(openTag: string): string {
  return /\bstyle="([^"]*)"/.exec(openTag)?.[1] ?? '';
}

interface MarkupElement {
  readonly openTag: string;
  /** 開始タグの位置。 */
  readonly start: number;
  /** 閉じタグの終わりの位置。 */
  readonly end: number;
  /** 中身の HTML。 */
  readonly inner: string;
}

/** `start` の位置の開始タグの要素を、対応する閉じタグまで切り出す。 */
function elementAt(html: string, start: number): MarkupElement | undefined {
  const open = /^<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/.exec(html.slice(start));
  if (open === null) return undefined;
  const name = open[1] as string;
  const tag = new RegExp(`<${name}\\b[^>]*>|</${name}>`, 'g');
  tag.lastIndex = start;
  let depth = 0;
  for (let match = tag.exec(html); match !== null; match = tag.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1;
    if (depth === 0) {
      return {
        openTag: open[0],
        start,
        end: match.index + match[0].length,
        inner: html.slice(start + open[0].length, match.index),
      };
    }
  }
  return undefined;
}

/** `white-space: pre-wrap` を持つ要素（本文の要素。056 実装プラン §8 の 7・8）。 */
function preWrapElements(html: string): MarkupElement[] {
  return [...html.matchAll(/<[a-zA-Z][a-zA-Z0-9]*\b[^>]*>/g)]
    .filter((match) => /white-space:\s*pre-wrap/.test(styleOf(match[0])))
    .map((match) => elementAt(html, match.index))
    .filter((element): element is MarkupElement => element !== undefined);
}

function bodyElementOf(html: string): MarkupElement {
  const elements = preWrapElements(html);
  expect(elements, 'white-space: pre-wrap の要素').toHaveLength(1);
  return elements[0] as MarkupElement;
}

/** `tf-visually-hidden` の要素（無ければ undefined）。 */
function hiddenLabelOf(html: string): MarkupElement | undefined {
  const match =
    /<[a-zA-Z][a-zA-Z0-9]*\b[^>]*\bclass="(?:[^"]*\s)?tf-visually-hidden(?:\s[^"]*)?"[^>]*>/.exec(
      html,
    );
  return match === null ? undefined : elementAt(html, match.index);
}

/** 改行を含む `POST_BODY_MAX_LENGTH` 字ちょうどの本文。 */
function maxLengthBody(): string {
  const line = 'とりふねの投稿の本文の一行。\n';
  const tail = '末尾まで確かめる本文';
  const head = line
    .repeat(Math.ceil(POST_BODY_MAX_LENGTH / line.length))
    .slice(0, POST_BODY_MAX_LENGTH - tail.length);
  return `${head}${tail}`;
}

/* -------------------------------------------------------------------------- */
/* #6 隠した見出しと本文そのまま                                                   */
/* -------------------------------------------------------------------------- */

describe('#6 PostBodyPreview は隠した「本文」の後に本文をそのまま出す', () => {
  it('#6 tf-visually-hidden の要素があり、中身が「本文」', async () => {
    const hidden = hiddenLabelOf(await render('秋のセールのお知らせ'));

    expect(hidden, 'tf-visually-hidden の要素').toBeDefined();
    expect(unescapeHtml(hidden?.inner ?? '')).toBe(HIDDEN_LABEL);
  });

  it('#6 white-space: pre-wrap を持つ要素がちょうど 1 つある', async () => {
    expect(preWrapElements(await render('秋のセールのお知らせ'))).toHaveLength(1);
  });

  it('#6 本文の要素は overflow-wrap: anywhere を持つ', async () => {
    expect(styleOf(bodyElementOf(await render('秋のセールのお知らせ')).openTag)).toMatch(
      /overflow-wrap:\s*anywhere/,
    );
  });

  it('#6 本文の要素は隠した「本文」の後にある（隠した要素の中ではない）', async () => {
    const html = await render('秋のセールのお知らせ');
    const hidden = hiddenLabelOf(html);
    const body = bodyElementOf(html);

    expect(hidden, 'tf-visually-hidden の要素').toBeDefined();
    expect(body.start).toBeGreaterThanOrEqual(hidden?.end ?? Number.POSITIVE_INFINITY);
  });

  it("#6 改行・連続した空白・タブ・前後の空白を変えずに入る（'  a\\n\\nb\\tc  '）", async () => {
    const body = '  a\n\nb\tc  ';

    expect(bodyElementOf(await render(body)).inner).toBe(body);
  });

  it('#6 全角の空白・行頭の字下げ・空行もそのまま入る', async () => {
    const body = '一行目\n　字下げした二行目\n\n\n四行目　　末尾';

    expect(bodyElementOf(await render(body)).inner).toBe(body);
  });

  it('#6 本文は HTML としてではなくテキストとして入る（エスケープだけ）', async () => {
    const body = '<b>太字</b> & "引用" \'記号\' <script>alert(1)</script>';
    const element = bodyElementOf(await render(body));

    expect(element.inner).not.toContain('<b>');
    expect(element.inner).not.toContain('<script');
    expect(unescapeHtml(element.inner)).toBe(body);
  });

  it('#6 本文の要素の中には本文の他の文字（「本文」の見出しなど）が入らない', async () => {
    const body = 'お知らせの本文';

    expect(unescapeHtml(bodyElementOf(await render(body)).inner)).toBe(body);
  });
});

/* -------------------------------------------------------------------------- */
/* #7 10,000 字                                                                 */
/* -------------------------------------------------------------------------- */

describe('#7 長い本文を切らない', () => {
  it('#7 前提：用意した本文が POST_BODY_MAX_LENGTH（10,000）字ちょうどで改行を含む', () => {
    const body = maxLengthBody();

    expect(POST_BODY_MAX_LENGTH).toBe(10_000);
    expect(body).toHaveLength(POST_BODY_MAX_LENGTH);
    expect(body).toContain('\n');
  });

  it('#7 10,000 字の本文が全文で入る', async () => {
    const body = maxLengthBody();

    expect(bodyElementOf(await render(body)).inner).toBe(body);
  });

  it('#7 10,000 字の本文に「…」を足さない', async () => {
    const body = maxLengthBody();
    const html = await render(body);

    expect(body).not.toContain('…');
    expect(html).not.toContain('…');
  });

  it('#7 61 字以上の本文も 60 字の抜粋にしない', async () => {
    const body = `${'あ'.repeat(70)}\n末尾`;

    expect(bodyElementOf(await render(body)).inner).toBe(body);
  });
});

/* -------------------------------------------------------------------------- */
/* #8 省略の指定が無い                                                            */
/* -------------------------------------------------------------------------- */

describe('#8 本文の要素に省略の指定が無い', () => {
  it('#8 本文の要素に -webkit-line-clamp・line-clamp が無い', async () => {
    const style = styleOf(bodyElementOf(await render('秋のセールのお知らせ')).openTag);

    expect(style).not.toMatch(/line-clamp/);
  });

  it('#8 本文の要素に overflow: hidden が無い', async () => {
    const style = styleOf(bodyElementOf(await render('秋のセールのお知らせ')).openTag);

    expect(style).not.toMatch(/overflow(?:-[xy])?:\s*hidden/);
  });

  it('#8 本文の要素に max-height が無い', async () => {
    const style = styleOf(bodyElementOf(await render('秋のセールのお知らせ')).openTag);

    expect(style).not.toMatch(/max-height/);
  });

  it('#8 出力のどこにも line-clamp が無い', async () => {
    expect(await render(maxLengthBody())).not.toMatch(/line-clamp/);
  });
});

/* -------------------------------------------------------------------------- */
/* #9 文言                                                                       */
/* -------------------------------------------------------------------------- */

describe('#9 POST_BODY_PREVIEW_LABEL', () => {
  it('#9 labels.ts から POST_BODY_PREVIEW_LABEL が export され、値が「本文」', () => {
    expect((labels as Record<string, unknown>)['POST_BODY_PREVIEW_LABEL']).toBe('本文');
  });
});
