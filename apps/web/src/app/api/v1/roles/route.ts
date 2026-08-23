import { requirePermission } from '@/application/authorization/authorize';
import { buildAuthorizationContext } from '@/application/authorization/context';
import { roleRepository } from '@/infrastructure/role-repository';
import { readCookie, requestInfoOf, SESSION_COOKIE } from '@/api/cookies';
import { dataResponse } from '@/api/errors';
import { withAuthorization } from '@/api/authorize';

export async function GET(request: Request): Promise<Response> {
  return withAuthorization(async () => {
    const context = await buildAuthorizationContext(
      readCookie(request, SESSION_COOKIE),
      requestInfoOf(request),
    );
    requirePermission(context, 'user.manage');

    const roles = await roleRepository.list(context.connection);
    return dataResponse(roles);
  });
}
