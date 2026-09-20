import { z } from 'zod';
import { ApiKeyId, BuildingId, SessionId, TenantId, UserId } from './ids.ts';

/**
 * Tenancy and identity contracts.
 *
 * A TENANT is a customer organisation — a facilities operator, a landlord, a
 * managing agent — owning one or more buildings. It is never a building tenant
 * in the commercial-occupier sense; that concept does not exist in this schema,
 * and if it is added it must be called `occupier`. Confusing the two in a
 * building-analytics product is not a naming quibble, it is a data breach
 * waiting for someone to write the obvious query.
 *
 * Mirrors 007_tenancy.sql. As everywhere else, the SQL enums and these arrays
 * must stay in sync.
 */

export const TENANT_STATUSES = ['active', 'suspended'] as const;
export const TenantStatus = z.enum(TENANT_STATUSES);
export type TenantStatus = z.infer<typeof TenantStatus>;

/**
 * Deliberately coarse. Finer-grained permissions belong in application policy,
 * not in an enum that every membership row has to agree with — and a role
 * lattice nobody can recite is one nobody audits.
 */
export const TENANT_ROLES = ['owner', 'admin', 'operator', 'viewer'] as const;
export const TenantRole = z.enum(TENANT_ROLES);
export type TenantRole = z.infer<typeof TenantRole>;

export const API_KEY_KINDS = ['device', 'service'] as const;
export const ApiKeyKind = z.enum(API_KEY_KINDS);
export type ApiKeyKind = z.infer<typeof ApiKeyKind>;

/** Ranked weakest to strongest, so authorisation is a comparison not a lookup. */
const ROLE_RANK: Readonly<Record<TenantRole, number>> = {
  viewer: 0,
  operator: 1,
  admin: 2,
  owner: 3,
} as const;

export function roleAtLeast(held: TenantRole, required: TenantRole): boolean {
  return ROLE_RANK[held] >= ROLE_RANK[required];
}

export const Tenant = z.object({
  id: TenantId,
  slug: z.string(),
  name: z.string(),
  status: TenantStatus,
  metadata: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type Tenant = z.infer<typeof Tenant>;

export const User = z.object({
  id: UserId,
  email: z.string().email(),
  displayName: z.string(),
  isActive: z.boolean(),
  lastLoginAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type User = z.infer<typeof User>;

/**
 * Who is acting, and on whose data.
 *
 * Every database call in the system takes one of these. It is produced only by
 * authenticating a session cookie or an API key — never assembled from request
 * parameters, which is the whole point: a caller cannot name the tenant it
 * wants to read.
 */
export const Principal = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    tenantId: TenantId,
    userId: UserId,
    sessionId: SessionId,
    role: TenantRole,
  }),
  z.object({
    kind: z.literal('api_key'),
    tenantId: TenantId,
    apiKeyId: ApiKeyId,
    keyKind: ApiKeyKind,
    scopes: z.array(z.string()),
  }),
]);
export type Principal = z.infer<typeof Principal>;

/** Scopes an API key can carry. Checked on the routes that accept keys. */
export const API_SCOPES = [
  /** A device or gateway posting telemetry to `POST /ingest`. */
  'ingest:write',
  /** The simulation worker relaying run events to `POST /internal/sim-event`. */
  'sim:notify',
  /**
   * The web service asking the simulation worker to run something.
   *
   * It authenticates the CALLER, not the tenant: one web service serves every
   * tenant, so the tenant still travels in `X-Tenant-Id`. The key is what makes
   * believing that header sound — see apps/sim/app/auth.py.
   */
  'sim:run',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function hasScope(principal: Principal, scope: ApiScope): boolean {
  return principal.kind === 'api_key' && principal.scopes.includes(scope);
}

/**
 * A user's tenants, for the switcher. `role` is this user's role in that
 * tenant, not a property of the tenant.
 */
export const TenantMembership = z.object({
  tenantId: TenantId,
  slug: z.string(),
  name: z.string(),
  role: TenantRole,
});
export type TenantMembership = z.infer<typeof TenantMembership>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  /** Optional: which tenant to activate when the user belongs to several. */
  tenantSlug: z.string().optional(),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const SessionInfo = z.object({
  user: User,
  tenant: Tenant,
  role: TenantRole,
  memberships: z.array(TenantMembership),
  /** The buildings this tenant owns — the dashboard's building picker. */
  buildings: z.array(z.object({ id: BuildingId, name: z.string() })),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SwitchTenantRequest = z.object({ tenantId: TenantId });
export type SwitchTenantRequest = z.infer<typeof SwitchTenantRequest>;
