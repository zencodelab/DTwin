import { withoutTenant } from '@dtwin/db';
import type {
  ControlCommand, ControlRefusal, SetpointCommandRequest, TenantRole,
} from '@dtwin/types';
import { log } from '../log.ts';
import { evaluate, type EnvelopeVerdict } from './envelope.ts';
import {
  claimCommands, expireStale, getSettings, insertCommand, loadZoneContext,
  releaseCommand, settleCommand,
} from './store.ts';

/**
 * Issuing and dispatching commands: the two places the envelope runs.
 *
 * Kept out of the HTTP layer so the in-process gateway (the device simulator,
 * which is this stack's simulated building) and a real external gateway go
 * through exactly the same lifecycle. A control path with two implementations
 * would be a control path with one of them untested.
 */

export type IssueResult =
  | { ok: true; command: ControlCommand; dryRun: false }
  | { ok: true; command: null; dryRun: true; verdict: Extract<EnvelopeVerdict, { ok: true }> }
  | { ok: false; refusal: ControlRefusal | 'unknown_zone'; message: string };

/**
 * The acting user's role in this tenant, from the database.
 *
 * NOT from a header. The API key says a caller may act on behalf of this
 * tenant's users and the header says which user, but the authority to command
 * is a fact about the membership and is looked up here. A proxy asserting
 * "this user is an operator" would be the worker trusting `X-Tenant-Id` all
 * over again — the mistake §(worker auth) exists to record.
 *
 * Unscoped because membership is identity, which carries no tenant policy.
 */
export async function memberRole(tenantId: string, userId: string): Promise<TenantRole | null> {
  return withoutTenant(async (db) => {
    const { rows } = await db.query<{ role: TenantRole }>(
      `SELECT m.role
         FROM tenant_members m
         JOIN users u ON u.id = m.user_id
        WHERE m.tenant_id = $1 AND m.user_id = $2 AND u.is_active`,
      [tenantId, userId],
    );
    return rows[0]?.role ?? null;
  });
}

export async function issueCommand(
  tenantId: string, userId: string, request: SetpointCommandRequest,
): Promise<IssueResult> {
  const role = await memberRole(tenantId, userId);
  if (role === null) {
    // Indistinguishable from a viewer on purpose: a caller must not learn
    // which user ids are members of which tenant by watching the refusal.
    return { ok: false, refusal: 'forbidden_role', message: 'this user may not issue commands' };
  }

  const [settings, zone] = await Promise.all([
    getSettings(tenantId),
    loadZoneContext(tenantId, request.zoneId),
  ]);

  if (!zone.zoneExists) {
    // 404-shaped, and it says nothing about other tenants: a zone belonging to
    // someone else is simply not this tenant's zone.
    return { ok: false, refusal: 'unknown_zone', message: 'unknown zone' };
  }

  const verdict = evaluate(
    { setpointTempC: request.setpointTempC, durationS: request.durationS },
    { settings, role, now: Date.now(), ...zone },
  );

  if (!verdict.ok) {
    log.info('control.refused', {
      zoneId: request.zoneId, refusal: verdict.refusal,
      requestedTempC: request.setpointTempC,
    });
    return { ok: false, refusal: verdict.refusal, message: verdict.message };
  }

  if (request.dryRun === true) return { ok: true, command: null, dryRun: true, verdict };

  const command = await insertCommand({
    tenantId,
    zoneId: request.zoneId,
    setpointTempC: request.setpointTempC,
    previousTempC: verdict.previousTempC,
    reason: request.reason,
    requestedBy: userId,
    expiresAt: verdict.expiresAt,
    effectiveUntil: verdict.effectiveUntil,
  });

  if (command === null) {
    // The unique index caught a race the context read could not: two operators
    // evaluated at the same moment and both saw no command in flight.
    return {
      ok: false, refusal: 'command_in_flight',
      message: 'another command for this zone was accepted a moment ago',
    };
  }

  log.info('control.issued', {
    commandId: command.id, zoneId: command.zoneId,
    setpointTempC: command.setpointTempC, previousTempC: command.previousTempC,
    effectiveUntil: command.effectiveUntil.toISOString(),
  });
  return { ok: true, command, dryRun: false };
}

/**
 * Hand a gateway its work, re-checking the envelope for each command.
 *
 * **This is the evaluation that matters.** The first one told a person yes
 * while they were still there to be told; this one runs against the world as
 * it is at the moment the command would actually reach equipment. In between,
 * the AHU can have faulted, the zone's sensor can have died, and the operator
 * can have switched control off — and a command dispatched then would be acting
 * on a judgement made about a building that no longer exists.
 *
 * A command that fails re-evaluation is released rather than failed: the
 * condition may clear before it expires, and a transient fault should not
 * consume the operator's intent. If it does not clear, expiry takes it.
 */
export async function claimForGateway(
  tenantId: string, gateway: string, limit: number,
): Promise<{ commands: ControlCommand[]; withheld: number }> {
  await expireStale(tenantId);

  const settings = await getSettings(tenantId);
  if (!settings.enabled) {
    // The kill switch, read on every claim and never cached. Commands already
    // queued stay queued and lapse on their own; nothing reaches equipment.
    return { commands: [], withheld: 0 };
  }

  const claimed = await claimCommands(tenantId, gateway, limit);
  const out: ControlCommand[] = [];
  let withheld = 0;

  for (const command of claimed) {
    const zone = await loadZoneContext(tenantId, command.zoneId);
    const role = await memberRole(tenantId, command.requestedBy);
    const verdict = evaluate(
      { setpointTempC: command.setpointTempC },
      {
        settings,
        role: role ?? 'viewer',
        now: Date.now(),
        ...zone,
        // The command being re-checked is itself the one in flight, and its
        // own existence must not be the reason it is refused.
        commandInFlight: false,
        // Nor may the rate limit refuse it: it was rate-checked when issued,
        // and `lastCommandAt` now includes this command.
        lastCommandAt: null,
      },
    );

    if (verdict.ok) {
      out.push(command);
      continue;
    }
    withheld += 1;
    await releaseCommand(tenantId, command.id,
      `withheld at dispatch: ${verdict.refusal} — ${verdict.message}`);
    log.warn('control.withheld', {
      commandId: command.id, zoneId: command.zoneId, refusal: verdict.refusal,
    });
  }

  return { commands: out, withheld };
}

export async function reportResult(
  tenantId: string, commandId: string, outcome: 'applied' | 'failed', detail?: string,
): Promise<ControlCommand | null> {
  const command = await settleCommand(tenantId, commandId, outcome, detail);
  if (command) {
    log.info(outcome === 'applied' ? 'control.applied' : 'control.failed', {
      commandId: command.id, zoneId: command.zoneId,
      setpointTempC: command.setpointTempC, detail: detail ?? null,
    });
  }
  return command;
}
