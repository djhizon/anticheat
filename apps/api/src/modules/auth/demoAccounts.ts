import type { SqliteAuthRepository } from './auth.repository.js';
import type { AuthService } from './auth.service.js';
import { SupabaseAuthError, type SupabaseAuthClient } from './supabaseAuth.js';

/** Only addresses on the reserved example.test domain may be created or modified by the seed. */
export function isDemoEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith('@example.test');
}

export interface DemoAccountContext {
  readonly repository: Pick<SqliteAuthRepository, 'findUserByEmail'>;
  readonly service: Pick<AuthService, 'provisionExternalUser' | 'register'>;
  /** Supabase client holding the service-role key; undefined means create LOCAL accounts. */
  readonly admin: SupabaseAuthClient | undefined;
  readonly warn: (message: string) => void;
}

/**
 * Make sure a demo account exists. With an admin client the account is created (pre-confirmed,
 * no email sent) through the admin API and mapped locally; otherwise it is a LOCAL account.
 * Real accounts are never touched: an existing Supabase password is only overwritten, and an
 * existing local account only adopted, for `@example.test` addresses.
 * Returns false when the account was skipped.
 */
export async function ensureDemoAccount(
  context: DemoAccountContext,
  email: string,
  password: string,
): Promise<boolean> {
  const { admin, repository, service, warn } = context;
  const existingLocal = repository.findUserByEmail(email);

  if (admin !== undefined && admin.hasServiceRole) {
    if (existingLocal?.authProvider === 'local' && !isDemoEmail(email)) {
      warn(`Skipping ${email}: it is an existing local account and not an @example.test address.`);
      return false;
    }

    let external;
    try {
      external = await admin.adminCreateUser(email, password);
    } catch (error) {
      if (!(error instanceof SupabaseAuthError) || error.status !== 422) {
        throw error;
      }
      const found = await admin.adminFindUserByEmail(email);
      if (found === null) {
        throw error;
      }
      if (!isDemoEmail(email)) {
        warn(
          `Skipping ${email}: it already exists in Supabase and is not an @example.test address, so its password is left unchanged.`,
        );
        return false;
      }
      await admin.adminUpdateUser(found.id, password);
      external = found;
    }
    service.provisionExternalUser(external, { adoptLocalByEmail: isDemoEmail(email) });
    return true;
  }

  if (existingLocal === null) {
    await service.register({ email, password });
  }
  return true;
}
