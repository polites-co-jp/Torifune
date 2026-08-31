import { Alert, Card } from '@/ui/components';

/**
 * ロールと Permission の対応表（015-settings）。
 *
 * **参照のみ。操作は置かない。**
 * ロールを編集できるようにすると、`user.manage` を持つ利用者が
 * 自分のロールへ権限を足せる経路が生まれる（`04_認証設計.md` §28）。
 * 必要になったときに、昇格対策の設計と合わせて別途決める。
 */

export interface PermissionMatrixProps {
  readonly roles: readonly { id: string; name: string; displayName: string }[];
  readonly permissions: readonly { name: string; displayName: string }[];
  /** ロール名 → その ロールが持つ Permission 名。 */
  readonly grants: Readonly<Record<string, readonly string[]>>;
}

export function PermissionMatrix(props: PermissionMatrixProps) {
  return (
    <>
      <h2 style={{ fontSize: '1.05rem', margin: '0 0 var(--tf-space-4)' }}>権限</h2>

      <div style={{ marginBottom: 'var(--tf-space-4)' }}>
        <Alert tone="info">
          ロールの作成・編集はこの画面では行えません。表示している内容は、いま有効な割り当てです。
        </Alert>
      </div>

      <Card>
        {/* 列が増えるため、表だけを横スクロールさせる。ページ全体は動かさない。 */}
        <div style={{ overflowX: 'auto' }} data-testid="permission-matrix">
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th
                  scope="col"
                  style={{
                    textAlign: 'left',
                    padding: 'var(--tf-space-2)',
                    borderBottom: '1px solid var(--tf-color-border)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  権限
                </th>
                {props.roles.map((role) => (
                  <th
                    key={role.id}
                    scope="col"
                    style={{
                      textAlign: 'center',
                      padding: 'var(--tf-space-2)',
                      borderBottom: '1px solid var(--tf-color-border)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {role.displayName}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {props.permissions.map((permission) => (
                <tr key={permission.name}>
                  <th
                    scope="row"
                    style={{
                      textAlign: 'left',
                      fontWeight: 'normal',
                      padding: 'var(--tf-space-2)',
                      borderBottom: '1px solid var(--tf-color-border)',
                    }}
                  >
                    {permission.displayName}
                    <code
                      style={{
                        marginLeft: 'var(--tf-space-2)',
                        color: 'var(--tf-color-text-muted)',
                      }}
                    >
                      {permission.name}
                    </code>
                  </th>
                  {props.roles.map((role) => {
                    const granted = props.grants[role.name]?.includes(permission.name) ?? false;
                    return (
                      <td
                        key={role.id}
                        style={{
                          textAlign: 'center',
                          padding: 'var(--tf-space-2)',
                          borderBottom: '1px solid var(--tf-color-border)',
                          color: granted ? 'var(--tf-color-text)' : 'var(--tf-color-text-muted)',
                        }}
                      >
                        {/* 記号だけだと読み上げで区別できないため、意味を添える。 */}
                        <span aria-label={granted ? 'あり' : 'なし'}>{granted ? '●' : '—'}</span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
