import { Alert, Card } from '@/ui/components';
import { HelpLink } from './help-link';
import { HELP_NEW_TAB_NOTE, HELP_NO_SETTINGS, HELP_SETTINGS_HEADING } from './labels';

/**
 * 設定画面の手順書の部分（041-plugin-help-docs 設計 §7.5）。
 *
 * 手順書は**設定のフォームより上**に置く（先に読むもの）。フォームに入力中の値がありうるので、
 * 手順書は新しいタブで開く。注記「新しいタブで開きます。…」はリンクごとではなく一覧の下に 1 回だけ出す
 * （実装プラン §8 の 11）。設定のフォームそのものはこの部品の外（ページ）が描く。
 */
export interface PluginSettingsHelpProps {
  /** Manifest の宣言の順。無ければ []。 */
  readonly helpDocs: readonly {
    readonly id: string;
    readonly title: string;
    readonly href: string;
  }[];
  /** `registerSettings` しているか。偽なら「この画面で変える設定がありません」を出す。 */
  readonly hasSettings: boolean;
}

export function PluginSettingsHelp({ helpDocs, hasSettings }: PluginSettingsHelpProps) {
  return (
    <>
      {helpDocs.length > 0 && (
        <div style={{ marginBottom: 'var(--tf-space-4)' }}>
          <Card title={HELP_SETTINGS_HEADING}>
            <ul
              style={{
                display: 'grid',
                gap: 'var(--tf-space-2)',
                listStyle: 'none',
                margin: 0,
                padding: 0,
              }}
            >
              {helpDocs.map((doc) => (
                <li key={doc.id}>
                  <HelpLink href={doc.href} title={doc.title} showNote={false} />
                </li>
              ))}
            </ul>
            <p className="tf-help-link-note">{HELP_NEW_TAB_NOTE}</p>
          </Card>
        </div>
      )}
      {!hasSettings && <Alert tone="info">{HELP_NO_SETTINGS}</Alert>}
    </>
  );
}
