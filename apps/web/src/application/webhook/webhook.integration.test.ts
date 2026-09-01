import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { uuidv7 } from 'uuidv7';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ForbiddenError, type AuthorizationContext } from '@/application/authorization/authorize';
import { authorizationContextFor } from '@/application/authorization/context';
import { emit } from '@/application/events';
import { withConnection } from '@/application/transaction';
import { deliverPendingWebhooks } from '@/application/webhook/deliver';
import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
} from '@/application/webhook/webhook-use-cases';
import type { UserIdentity } from '@/authentication/identity';
import { ValidationError } from '@/domain/repository';
import { verifySignature } from '@/domain/webhook/webhook';
import { roleRepository } from '@/infrastructure/role-repository';
import { useScratchDatabase, type ScratchDatabase } from '@/test-support/database';

/**
 * Webhook（05_API設計.md §39、023-webhook）。
 *
 * **実際に受け取るサーバーを立てて確かめる。** 署名の検証は受け手の仕事なので、
 * 受け手の立場で検証できることまで見ないと「届いた」と言えない。
 */

let scratch: ScratchDatabase;
let admin: AuthorizationContext;

interface Received {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/** テスト用の受け手。応答コードを差し替えられる。 */
async function receiver(): Promise<{
  url: string;
  received: Received[];
  setStatus: (status: number) => void;
  close: () => Promise<void>;
  server: Server;
}> {
  const received: Received[] = [];
  let status = 200;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(status).end();
    });
  });

  // listen は非同期。待たずに address() を読むと null になる。
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/hook`,
    received,
    setStatus: (next) => {
      status = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    server,
  };
}

async function contextFor(roleName: string): Promise<AuthorizationContext> {
  const id = uuidv7();
  const suffix = id.replaceAll('-', '').slice(-12);

  await withConnection(async (connection) => {
    await connection.db
      .insertInto('users')
      .values({
        id,
        login_id: `w${suffix}`,
        email: `w${suffix}@example.com`,
        display_name: 'webhook test',
      })
      .execute();

    const role = await roleRepository.findByName(connection, roleName);
    if (role === null) throw new Error(`ロールが無い: ${roleName}`);
    await connection.db
      .insertInto('user_roles')
      .values({ user_id: id, role_id: role.id })
      .execute();
  });

  const identity: UserIdentity = {
    userId: id,
    loginId: `w${suffix}`,
    displayName: 'webhook test',
    email: `w${suffix}@example.com`,
    providerId: 'local',
    externalUserId: null,
  };

  return withConnection(async (connection) => authorizationContextFor(connection, identity));
}

async function deliver(): Promise<ReturnType<typeof deliverPendingWebhooks>> {
  return withConnection((connection) => deliverPendingWebhooks(connection));
}

beforeAll(async () => {
  scratch = await useScratchDatabase('webhook');
  admin = await contextFor('administrator');
});

afterAll(async () => {
  await scratch.dispose();
});

afterEach(async () => {
  await withConnection(async (connection) => {
    await connection.db.deleteFrom('webhook_deliveries').execute();
    await connection.db.deleteFrom('webhooks').execute();
    await connection.db.deleteFrom('audit_logs').execute();
  });
});

describe('登録', () => {
  it('Secret は発行時に一度だけ返る', async () => {
    const created = await createWebhook(admin, {
      name: 'テスト',
      url: 'https://hooks.example.com/x',
      events: ['site.created'],
    });

    expect(created.secret).toMatch(/^whsec_/);

    // 一覧には出ない。
    const list = await listWebhooks(admin, {});
    expect(JSON.stringify(list)).not.toContain(created.secret);
  });

  it('DB に Secret の平文が無い', async () => {
    const created = await createWebhook(admin, {
      name: 'テスト',
      url: 'https://hooks.example.com/x',
      events: [],
    });

    const rows = await withConnection((connection) =>
      connection.db.selectFrom('webhooks').selectAll().execute(),
    );
    expect(JSON.stringify(rows)).not.toContain(created.secret);
  });

  /** 平文で送ると、署名があっても中身は読まれる。 */
  it('http の URL を登録できない', async () => {
    await expect(
      createWebhook(admin, { name: 'x', url: 'http://hooks.example.com/x', events: [] }),
    ).rejects.toThrow(ValidationError);
  });

  /** Core が「外へ送ってよい」と判断できない（設計 §3.1）。 */
  it('Plugin のイベントは登録できない', async () => {
    await expect(
      createWebhook(admin, {
        name: 'x',
        url: 'https://hooks.example.com/x',
        events: ['com.example.plugin.something'],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('system.manage が無ければ登録できない', async () => {
    const editor = await contextFor('editor');
    await expect(
      createWebhook(editor, { name: 'x', url: 'https://hooks.example.com/x', events: [] }),
    ).rejects.toThrow(ForbiddenError);
  });

  it('削除できる', async () => {
    const created = await createWebhook(admin, {
      name: 'テスト',
      url: 'https://hooks.example.com/x',
      events: [],
    });

    await deleteWebhook(admin, { id: created.webhook.id });

    expect(await listWebhooks(admin, {})).toHaveLength(0);
  });
});

describe('配信', () => {
  it('イベントが起きると予約され、送ると届く', async () => {
    const target = await receiver();
    try {
      const created = await createWebhook(admin, {
        name: 'テスト',
        url: target.url,
        events: ['site.created'],
      });

      await emit('site.created', { siteId: 's1', name: 'とりふね' });

      // 発火の時点ではまだ送っていない（設計 §3.4）。
      expect(target.received).toHaveLength(0);

      const result = await deliver();

      expect(result.delivered).toBe(1);
      expect(target.received).toHaveLength(1);

      const body = target.received[0]?.body ?? '';
      expect(JSON.parse(body)).toEqual({
        event: 'site.created',
        data: { siteId: 's1', name: 'とりふね' },
      });

      // **受け手の立場で署名を検証できる。**
      const headers = target.received[0]?.headers ?? {};
      const timestamp = Number(headers['x-torifune-timestamp']);
      const signature = String(headers['x-torifune-signature']).replace('sha256=', '');
      expect(verifySignature(created.secret, timestamp, body, signature)).toBe(true);

      // 配信IDがある（受け手が二重処理を避けるため）。
      expect(headers['x-torifune-delivery']).toBeDefined();
    } finally {
      await target.close();
    }
  });

  it('購読していないイベントは届かない', async () => {
    const target = await receiver();
    try {
      await createWebhook(admin, { name: 'テスト', url: target.url, events: ['site.created'] });

      await emit('site.deleted', { siteId: 's1' });
      await deliver();

      expect(target.received).toHaveLength(0);
    } finally {
      await target.close();
    }
  });

  it('止めている Webhook へは送らない', async () => {
    const target = await receiver();
    try {
      const created = await createWebhook(admin, {
        name: 'テスト',
        url: target.url,
        events: ['site.created'],
      });
      await emit('site.created', { siteId: 's1' });

      await withConnection((connection) =>
        connection.db
          .updateTable('webhooks')
          .set({ status: 'paused' })
          .where('id', '=', created.webhook.id)
          .execute(),
      );

      await deliver();

      expect(target.received).toHaveLength(0);
    } finally {
      await target.close();
    }
  });

  /** 落ちている受け手を叩き続けない。 */
  it('失敗すると再試行の予約になる', async () => {
    const target = await receiver();
    target.setStatus(500);
    try {
      await createWebhook(admin, { name: 'テスト', url: target.url, events: ['site.created'] });
      await emit('site.created', { siteId: 's1' });

      const result = await deliver();

      expect(result.delivered).toBe(0);
      expect(result.failed).toBe(0);

      const rows = await withConnection((connection) =>
        connection.db
          .selectFrom('webhook_deliveries')
          .select(['status', 'attempts', 'last_error'])
          .execute(),
      );
      expect(rows[0]?.status).toBe('pending');
      expect(rows[0]?.attempts).toBe(1);
      expect(rows[0]?.last_error).toContain('500');
    } finally {
      await target.close();
    }
  });

  /** 再試行の間隔が空くので、すぐには送らない。 */
  it('再試行の予約時刻まで送らない', async () => {
    const target = await receiver();
    target.setStatus(500);
    try {
      await createWebhook(admin, { name: 'テスト', url: target.url, events: ['site.created'] });
      await emit('site.created', { siteId: 's1' });

      await deliver();
      const again = await deliver();

      expect(again.attempted).toBe(0);
      expect(target.received).toHaveLength(1);
    } finally {
      await target.close();
    }
  });

  it('上限まで失敗すると諦める', async () => {
    const target = await receiver();
    target.setStatus(500);
    try {
      await createWebhook(admin, { name: 'テスト', url: target.url, events: ['site.created'] });
      await emit('site.created', { siteId: 's1' });

      // 5回分。毎回「次に試してよい時刻」を過去へ戻して即座に試す。
      for (let i = 0; i < 5; i += 1) {
        await withConnection((connection) =>
          connection.db
            .updateTable('webhook_deliveries')
            .set({ next_attempt_at: new Date(Date.now() - 1000) })
            .execute(),
        );
        await deliver();
      }

      const rows = await withConnection((connection) =>
        connection.db.selectFrom('webhook_deliveries').select(['status', 'attempts']).execute(),
      );
      expect(rows[0]?.status).toBe('failed');
      expect(rows[0]?.attempts).toBe(5);
    } finally {
      await target.close();
    }
  });

  /** 受け手はこの ID で二重処理を避ける（設計 §3.5）。 */
  it('再試行でも配信IDが変わらない', async () => {
    const target = await receiver();
    target.setStatus(500);
    try {
      await createWebhook(admin, { name: 'テスト', url: target.url, events: ['site.created'] });
      await emit('site.created', { siteId: 's1' });

      await deliver();
      await withConnection((connection) =>
        connection.db
          .updateTable('webhook_deliveries')
          .set({ next_attempt_at: new Date(Date.now() - 1000) })
          .execute(),
      );
      await deliver();

      expect(target.received).toHaveLength(2);
      expect(target.received[0]?.headers['x-torifune-delivery']).toBe(
        target.received[1]?.headers['x-torifune-delivery'],
      );
    } finally {
      await target.close();
    }
  });

  /** Webhook は付随的な機能で、それで本体の操作を落とす理由が無い。 */
  it('Webhook が無くてもイベントの発火は成功する', async () => {
    await expect(emit('site.created', { siteId: 's1' })).resolves.toBeUndefined();
  });
});
