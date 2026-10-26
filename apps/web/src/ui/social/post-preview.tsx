import type { CSSProperties } from 'react';
import { POST_BODY_PREVIEW_LABEL } from '@/ui/social/labels';

/**
 * 一覧の 2 段目に置く本文（056-social-row-layout 設計 §5.3）。
 *
 * 本文は**省略せず全文**を、**改行と空白を投稿どおりに**出す（`pre-wrap`）。
 * 表の幅で折り返し、空白の無い長い URL も表を押し広げない（`overflow-wrap: anywhere`）。
 * 本文は React のテキストとして描く（HTML として差し込まない）。
 */

const BODY_STYLE: CSSProperties = {
  display: 'block',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

export interface PostBodyPreviewProps {
  readonly body: string;
}

export function PostBodyPreview({ body }: PostBodyPreviewProps) {
  return (
    <>
      <span className="tf-visually-hidden">{POST_BODY_PREVIEW_LABEL}</span>
      <span style={BODY_STYLE}>{body}</span>
    </>
  );
}
