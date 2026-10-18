import { z } from 'zod';
import { passwordSchema } from '../../auth/password';
import { defineRoute, type RouteDef } from '../../shared/http';
import { ROLES } from '../../rbac/permissions';
import { createUser, listUsers, updateUser } from './service';

// What changed, never the password itself.
const changes = (
  userId: number,
  b: { name?: string; role?: string; active?: boolean; password?: string },
) => ({
  user_id: userId,
  fields: Object.keys(b).sort(),
  ...(b.role ? { role: b.role } : {}),
  ...(b.active !== undefined ? { active: b.active } : {}),
});

const idParams = z.strictObject({ id: z.coerce.number().int().positive() });
const name = z.string().trim().min(1).max(100);

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
        role: z.enum(ROLES),
        password: passwordSchema,
      }),
      async handler({ body, res, user: actor }, { db, config, audit }) {
        const user = await createUser(db, body, config.BCRYPT_COST);
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
          role: z.enum(ROLES).optional(),
          active: z.boolean().optional(),
          password: passwordSchema.optional(),
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
  ];
}
