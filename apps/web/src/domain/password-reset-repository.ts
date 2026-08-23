import type { Connection } from '../database/provider';

export interface PasswordResetToken {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

export interface NewPasswordResetToken {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

export interface PasswordResetRepository {
  insert(connection: Connection, token: NewPasswordResetToken): Promise<void>;
  findByTokenHash(connection: Connection, tokenHash: string): Promise<PasswordResetToken | null>;
  markUsed(connection: Connection, id: string, at: Date): Promise<void>;
}
