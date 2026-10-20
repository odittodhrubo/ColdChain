import { z } from 'zod';
import { passwordSchema } from '../../auth/password';
import { DISPLAY_TOKEN_TTL_S, signToken } from '../../auth/tokens';
import { defineRoute, type RouteDef } from '../../shared/http';
import { ROLES } from '../../rbac/permissions';
import {
  createDisplay,
  createUser,
  listDisplays,
  listUsers,
  requirePasswordChange,
  revokeDisplay,
  updateUser,
} from './service';

// What changed, never the password itself.
const changes = (
  userId: number,
  b: { name?: string; role?: string; active?: boolean; password?: string; totp_reset?: boolean },
) => ({
  user_id: userId,
  fields: Object.keys(b).sort(),
  ...(b.role ? { role: b.role } : {}),
  ...(b.active !== undefined ? { active: b.active } : {}),
});

const idParams = z.strictObject({ id: z.coerce.number().int().positive() });
const name = z.string().trim().min(1).max(100);
// Staff roles only: a DISPLAY principal (P1) is never created or assigned through the people endpoints.
const staffRole = z.enum(ROLES.filter((r) => r !== 'DISPLAY') as ['ADMIN', 'PHARMACIST', 'INSPECTOR']);

// Admin only. Strict schemas: unknown fields (e.g. password_hash, id) are rejected, never mass-assigned.
export function userRoutes(): RouteDef[] {
  return [
    defineRoute({
      method: 'get',
      path: '/api/users',
      access: { permission: 'user:manage' },
      handler: (_in, { db }) => ({ users: listUsers(db) }),
    }),

    defineRoute({
      method: 'post',
      path: '/api/users',
      access: { permission: 'user:manage' },
      body: z.strictObject({
        email: z.email().max(254),
        name,
        role: staffRole,
        password: passwordSchema,
      }),
      async handler({ body, res, user: actor }, { db, config, audit }) {
        const user = await createUser(db, body, config.BCRYPT_COST);
        requirePasswordChange(db, user.id); // the Admin chose it: the user picks their own at first sign-in
        audit.append(`user:${actor!.id}`, 'USER_CREATED', {
          user_id: user.id,
          email: user.email,
          role: user.role,
        });
        res.status(201).json({ user });
      },
    }),

    defineRoute({
      method: 'patch',
      path: '/api/users/:id',
      access: { permission: 'user:manage' },
      params: idParams,
      body: z
        .strictObject({
          name: name.optional(),
          role: staffRole.optional(),
          active: z.boolean().optional(),
          password: passwordSchema.optional(), // temporary: the user must change it at next sign-in (S2)
          totp_reset: z.literal(true).optional(), // switch the user's two-factor off (lost phone, S3)
        })
        .refine((b) => Object.keys(b).length > 0, 'nothing to update'),
      async handler({ params, body, user: actor }, { db, config, audit }) {
        const user = await updateUser(db, params.id, body, config.BCRYPT_COST);
        audit.append(
          `user:${actor!.id}`,
          body.active === false ? 'USER_DISABLED' : 'USER_UPDATED',
          changes(user.id, body),
        );
        return { user };
      },
    }),

    defineRoute({
      method: 'delete',
      path: '/api/users/:id',
      access: { permission: 'user:manage' },
      params: idParams,
      // Users are disabled, not deleted: their id stays valid in the audit log and batch history.
      async handler({ params, user: actor }, { db, config, audit }) {
        const user = await updateUser(db, params.id, { active: false }, config.BCRYPT_COST);
        audit.append(`user:${actor!.id}`, 'USER_DISABLED', changes(user.id, { active: false }));
        return { user };
      },
    }),

    // P1: wall-display tokens. Created and revoked here (Users page); read-only (role DISPLAY in the matrix).
    defineRoute({
      method: 'get',
      path: '/api/displays',
      access: { permission: 'user:manage' },
      handler: (_in, { db }) => ({ displays: listDisplays(db) }),
    }),

    defineRoute({
      method: 'post',
      path: '/api/displays',
      access: { permission: 'user:manage' },
      body: z.strictObject({ label: name }),
      async handler({ body, res, user: actor }, { db, config, audit }) {
        const display = await createDisplay(db, body.label, config.BCRYPT_COST);
        // The link carries the token in the fragment, so it never reaches the server logs or the Referer header.
        const { token, exp } = signToken(
          { id: display.id, role: 'DISPLAY', name: display.label },
          config,
          DISPLAY_TOKEN_TTL_S,
        );
        const url = `${config.PUBLIC_BASE_URL.replace(/\/+$/, '')}/display#token=${token}`;
        audit.append(`user:${actor!.id}`, 'DISPLAY_TOKEN_CREATED', { display_id: display.id, label: display.label });
        res.status(201).json({ display, token, url, expiresAt: exp });
      },
    }),

    defineRoute({
      method: 'post',
      path: '/api/displays/:id/revoke',
      access: { permission: 'user:manage' },
      params: idParams,
      handler({ params, user: actor }, { db, audit }) {
        const display = revokeDisplay(db, params.id);
        audit.append(`user:${actor!.id}`, 'DISPLAY_TOKEN_REVOKED', { display_id: display.id });
        return { display };
      },
    }),
  ];
}
