import { lookup } from 'node:dns/promises';
import { createTransport, type Transporter } from 'nodemailer';
import { withTenant } from '@dtwin/db';
import { activeTenants } from '../tenants.ts';
import type { AlertWithContext } from '@dtwin/types';
import type { Config } from '../config.ts';

/**
 * Alert notification delivery.
 *
 * `alert_rules.notify` holds channel configuration edited by operators, so a
 * webhook URL is untrusted input that this process will make a request to. Two
 * consequences shape this module:
 *
 * 1. **Destinations are resolved and checked before the request.** A URL
 *    pointing at 169.254.169.254, localhost or an RFC1918 address turns the
 *    ingest service into a proxy for anything on the internal network. Checking
 *    the hostname string is not enough — a name can resolve to a private
 *    address — so the check is on the resolved IP.
 * 2. **Every attempt is recorded.** The first question after an incident is
 *    "was anyone actually told?", and an in-memory counter cannot answer it
 *    after a restart. `alert_notifications` carries the answer, including the
 *    failures.
 *
 * Disabled by default: sending is outward-facing, and a dev database seeded
 * with someone's real webhook should not start calling it because the service
 * booted.
 */

/** A row this worker has claimed and is responsible for delivering. */
interface ClaimedRow {
  id: string;
  alert_id: string;
  channel: string;
  target: string;
}

export interface NotifyTarget {
  channel: 'webhook' | 'email' | 'log';
  target: string;
}

export interface NotifyStats {
  delivered: number;
  failed: number;
  blocked: number;
  skipped: number;
}

/** Parse the rule's `notify` jsonb into concrete destinations. */
export function parseTargets(notify: unknown): NotifyTarget[] {
  if (typeof notify !== 'object' || notify === null) return [];
  const config = notify as Record<string, unknown>;
  const out: NotifyTarget[] = [];

  const webhook = config.webhook;
  if (typeof webhook === 'string' && webhook.length > 0) {
    out.push({ channel: 'webhook', target: webhook });
  }

  const email = config.email;
  if (Array.isArray(email)) {
    for (const address of email) {
      if (typeof address === 'string' && address.includes('@')) {
        out.push({ channel: 'email', target: address });
      }
    }
  } else if (typeof email === 'string' && email.includes('@')) {
    out.push({ channel: 'email', target: email });
  }

  if (config.log === true) out.push({ channel: 'log', target: 'stdout' });

  return out;
}

const PRIVATE_V4 = [
  /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^0\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

/**
 * Whether a destination is safe to request.
 *
 * Resolution happens here rather than being left to fetch, because the decision
 * has to be made about the address actually contacted.
 */
export async function checkDestination(
  rawUrl: string,
  allowPrivate: boolean,
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not a valid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `unsupported protocol ${url.protocol}` };
  }

  if (allowPrivate) return { ok: true, url };

  try {
    const { address, family } = await lookup(url.hostname);
    const isPrivate =
      family === 6
        ? /^(::1|fc|fd|fe80)/i.test(address)
        : PRIVATE_V4.some((re) => re.test(address));

    if (isPrivate) {
      return { ok: false, reason: `resolves to a private address (${address})` };
    }
  } catch (err) {
    return { ok: false, reason: `DNS lookup failed: ${(err as Error).message}` };
  }

  return { ok: true, url };
}

export class Notifier {
  #stats: NotifyStats = { delivered: 0, failed: 0, blocked: 0, skipped: 0 };
  #retryTimer: NodeJS.Timeout | null = null;

  /**
   * One transporter, built on first use and kept.
   *
   * nodemailer pools connections, so rebuilding it per alert would open a new
   * SMTP session each time — and an alert storm is exactly when that costs.
   * Built lazily rather than in the constructor so a service with no email
   * destination never opens one at all.
   */
  #mailer: Transporter | null = null;

  #transport(): Transporter | null {
    const url = this.config.ALERT_SMTP_URL;
    if (!url) return null;

    // The URL is parsed here rather than handed to nodemailer as a string,
    // because createTransport's second argument is message DEFAULTS, not
    // transport options — the timeouts below would have been silently
    // interpreted as headers on every message.
    const parsed = new URL(url);
    const secure = parsed.protocol === 'smtps:';

    this.#mailer ??= createTransport({
      host: parsed.hostname,
      port: Number(parsed.port) || (secure ? 465 : 587),
      secure,
      auth: parsed.username
        ? {
          user: decodeURIComponent(parsed.username),
          pass: decodeURIComponent(parsed.password),
        }
        : undefined,
      // An alert is dispatched off the alert path, but it is still a queue that
      // a hanging relay would fill.
      connectionTimeout: this.config.ALERT_EMAIL_TIMEOUT_MS,
      greetingTimeout: this.config.ALERT_EMAIL_TIMEOUT_MS,
      socketTimeout: this.config.ALERT_EMAIL_TIMEOUT_MS,
      // A relay on the same host, reached over plain SMTP, is the normal shape
      // for this; requiring a valid certificate there would refuse it.
      tls: { rejectUnauthorized: secure },
    });
    return this.#mailer;
  }

  constructor(private readonly config: Config) {}

  start(): void {
    if (!this.config.ALERT_NOTIFY_ENABLED) return;
    this.#retryTimer ??= setInterval(() => {
      void this.retryPending().catch((err: unknown) => {
        console.error('[notify] retry sweep failed:', (err as Error).message);
      });
    }, this.config.ALERT_NOTIFY_RETRY_MS);
  }

  stop(): void {
    if (this.#retryTimer) clearInterval(this.#retryTimer);
    this.#retryTimer = null;
  }

  get stats(): NotifyStats & { enabled: boolean } {
    return { ...this.#stats, enabled: this.config.ALERT_NOTIFY_ENABLED };
  }

  /**
   * Record and attempt every destination configured for this alert's rule.
   *
   * `tenantId` travels with the alert rather than being looked up: the
   * delivery record lives in `alert_notifications`, which is policy-scoped, so
   * writing it needs the tenant the alert belongs to.
   */
  /**
   * Deliver everything already recorded for one alert.
   *
   * The fast path after `openAlert` committed the rows. It claims them the
   * same way the sweep does, so the two cannot both send the same row — a
   * sweep that happens to be running when an alert opens is the ordinary case,
   * not an edge one.
   */
  async deliverForAlert(tenantId: string, alert: AlertWithContext): Promise<void> {
    if (!this.config.ALERT_NOTIFY_ENABLED) return;
    const claimed = await this.#claim(tenantId, alert.id);
    await this.#deliverClaimed(tenantId, claimed, alert);
  }

  /**
   * The destinations to record for an alert, given this deployment's config.
   *
   * Empty when notifications are disabled, and that is deliberate rather than
   * an oversight in the outbox. `ALERT_NOTIFY_ENABLED` is false by default, so
   * writing the rows anyway would give every deployment that has not opted in
   * an unbounded queue of `pending` deliveries — and then flood every one of
   * them the moment somebody turned it on. A switch that says "this deployment
   * does not send notifications" should not be quietly accumulating the ones
   * it did not send.
   *
   * The count still moves, so /healthz can say how many were skipped rather
   * than leaving the difference unexplained.
   */
  targetsFor(notify: unknown): NotifyTarget[] {
    const targets = parseTargets(notify);
    if (this.config.ALERT_NOTIFY_ENABLED) return targets;
    this.#stats.skipped += targets.length;
    return [];
  }

  /** Deliver a batch of claimed rows, loading each alert only if needed. */
  async #deliverClaimed(
    tenantId: string,
    rows: ClaimedRow[],
    known?: AlertWithContext,
  ): Promise<void> {
    for (const row of rows) {
      const alert = known && known.id === row.alert_id
        ? known
        : await loadAlert(tenantId, row.alert_id);
      if (!alert) continue; // the alert was deleted under us; nothing to send
      await this.#deliverOne(tenantId, alert, row);
    }
  }

  async #deliverOne(
    tenantId: string,
    alert: AlertWithContext,
    row: ClaimedRow,
  ): Promise<void> {
    const id = row.id;
    const target: NotifyTarget = {
      channel: row.channel as NotifyTarget['channel'],
      target: row.target,
    };

    if (target.channel === 'log') {
      console.log(`[notify] ${alert.severity.toUpperCase()} ${alert.message}`);
      await this.#markDelivered(tenantId, id);
      this.#stats.delivered++;
      return;
    }

    if (target.channel === 'email') {
      await this.#deliverEmail(tenantId, id, alert, target.target);
      return;
    }

    await this.#deliverWebhook(tenantId, id, alert, target.target);
  }

  /**
   * Send one alert as mail.
   *
   * With no `ALERT_SMTP_URL` this records `failed` with the reason, exactly as
   * before — the honest answer to "was anyone told?", and better than a channel
   * that looks wired and is not. What changed is that configuring it now does
   * something.
   *
   * The body is deliberately plain text. An alert is read on a phone at an odd
   * hour by someone deciding whether to drive to a building; HTML mail buys
   * nothing there and costs a rendering surface.
   */
  async #deliverEmail(
    tenantId: string,
    id: string,
    alert: AlertWithContext,
    address: string,
  ): Promise<void> {
    const mailer = this.#transport();
    if (!mailer) {
      await this.#markFailed(tenantId, id, 'no email transport configured');
      this.#stats.failed++;
      return;
    }
    if (!this.config.ALERT_EMAIL_FROM) {
      await this.#markFailed(tenantId, id, 'ALERT_EMAIL_FROM is not set');
      this.#stats.failed++;
      return;
    }

    const where = [alert.zoneName, alert.floorName, alert.equipmentTag]
      .filter(Boolean).join(' · ');

    try {
      await mailer.sendMail({
        from: this.config.ALERT_EMAIL_FROM,
        to: address,
        subject: `[${alert.severity}] ${alert.ruleName}${where ? ` — ${where}` : ''}`,
        text: [
          alert.message,
          '',
          where && `Location: ${where}`,
          alert.sensorName && `Point: ${alert.sensorName}`,
          alert.triggerValue !== null && `Reading: ${alert.triggerValue}`,
          alert.threshold !== null && `Threshold: ${alert.threshold}`,
          `Opened: ${new Date(alert.openedAt).toISOString()}`,
          `Alert id: ${alert.id}`,
        ].filter(Boolean).join('\n'),
      });
      await this.#markDelivered(tenantId, id);
      this.#stats.delivered++;
    } catch (err) {
      // Recorded, not thrown: the retry sweep owns whether to try again, and
      // an alert that could not be mailed must not take the engine with it.
      await this.#markFailed(tenantId, id, (err as Error).message);
      this.#stats.failed++;
    }
  }

  async #deliverWebhook(
    tenantId: string,
    id: string,
    alert: AlertWithContext,
    rawUrl: string,
  ): Promise<void> {
    const check = await checkDestination(rawUrl, this.config.ALERT_WEBHOOK_ALLOW_PRIVATE);
    if (!check.ok) {
      await this.#markFailed(tenantId, id, `blocked: ${check.reason}`);
      this.#stats.blocked++;
      console.warn(`[notify] blocked webhook ${rawUrl}: ${check.reason}`);
      return;
    }

    try {
      const response = await fetch(check.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ event: 'alert.raised', alert }),
        // Bounded: a hung endpoint must not pin a connection while alerts keep
        // arriving. `redirect: manual` stops a public URL redirecting into the
        // private range the check just cleared it of.
        signal: AbortSignal.timeout(this.config.ALERT_WEBHOOK_TIMEOUT_MS),
        redirect: 'manual',
      });

      if (!response.ok) {
        await this.#markFailed(tenantId, id, `HTTP ${response.status}`);
        this.#stats.failed++;
        return;
      }

      await this.#markDelivered(tenantId, id);
      this.#stats.delivered++;
    } catch (err) {
      await this.#markFailed(tenantId, id, (err as Error).message);
      this.#stats.failed++;
    }
  }

  /**
   * Deliver everything outstanding, for every tenant.
   *
   * This is the outbox's actual engine, not merely a retry. Every `pending`
   * row arrives here eventually, whether the fast path after `openAlert` ran
   * or not — which is what makes losing that call cost one interval rather
   * than a notification.
   *
   * It used to filter `channel = 'webhook'`, which was survivable while the
   * notifier created its own rows immediately after an alert: a log or email
   * row was written and delivered in the same breath, so it was never left
   * pending. Now that the rows are committed with the alert and delivered
   * afterwards, a channel this sweep ignores is a channel that never recovers
   * from a restart.
   *
   * Bounded by attempt count: an endpoint down for a day should stop being
   * called, and the row keeps the last error so the reason survives.
   */
  async retryPending(): Promise<number> {
    if (!this.config.ALERT_NOTIFY_ENABLED) return 0;

    let total = 0;
    // Per tenant: the sweep reads policy-scoped tables, so there is no single
    // query that can see every pending delivery.
    for (const tenant of await activeTenants()) {
      const rows = await this.#claim(tenant.id, null);
      await this.#deliverClaimed(tenant.id, rows);
      total += rows.length;
    }
    return total;
  }

  /**
   * Take ownership of deliverable rows, so no other worker sends them.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe with more than one ingest
   * replica: each worker locks a disjoint set and the others step over them
   * instead of blocking. Without it the sweep was a plain SELECT, and two
   * replicas read the same row and both sent it.
   *
   * `claimed_at` is a LEASE, not a flag. A worker that dies mid-delivery would
   * otherwise hold its rows forever; past the lease they are claimable again.
   * The cost is the honest limit of at-least-once: a worker that is merely
   * slow, rather than dead, can have a row taken from under it and the
   * receiver sees it twice. Every payload carries the alert id, which is what
   * a receiver would key its own idempotency on.
   *
   * `alertId` narrows it to one alert for the fast path; null sweeps the
   * tenant.
   */
  async #claim(tenantId: string, alertId: string | null): Promise<ClaimedRow[]> {
    return withTenant({ tenantId }, async (db) => {
      const { rows } = await db.query<ClaimedRow>(
        `UPDATE alert_notifications n
            SET claimed_at = now()
          WHERE n.id IN (
                  SELECT c.id
                    FROM alert_notifications c
                    JOIN alerts a ON a.id = c.alert_id
                   WHERE c.status <> 'delivered'
                     AND c.attempts < $1
                     AND a.state <> 'resolved'
                     AND ($2::uuid IS NULL OR c.alert_id = $2::uuid)
                     AND (c.claimed_at IS NULL
                          OR c.claimed_at < now() - ($3 || ' milliseconds')::interval)
                   ORDER BY c.created_at
                   LIMIT $4
                   FOR UPDATE OF c SKIP LOCKED
                )
      RETURNING n.id, n.alert_id, n.channel, n.target`,
        [
          this.config.ALERT_WEBHOOK_MAX_ATTEMPTS,
          alertId,
          this.config.ALERT_NOTIFY_LEASE_MS,
          this.config.ALERT_NOTIFY_BATCH,
        ],
      );
      return rows;
    });
  }

  async #markDelivered(tenantId: string, id: string): Promise<void> {
    await withTenant({ tenantId }, (db) => db.query(
      `UPDATE alert_notifications
          SET status='delivered', delivered_at=now(), attempts=attempts+1, last_error=NULL
        WHERE id=$1`,
      [id],
    ));
  }

  async #markFailed(tenantId: string, id: string, error: string): Promise<void> {
    await withTenant({ tenantId }, (db) => db.query(
      `UPDATE alert_notifications
          SET status='failed', attempts=attempts+1, last_error=$2
        WHERE id=$1`,
      [id, error.slice(0, 1000)],
    ));
  }
}

async function loadAlert(
  tenantId: string,
  alertId: string,
): Promise<AlertWithContext | null> {
  const { byId } = await import('./store.ts');
  return byId(tenantId, alertId);
}
