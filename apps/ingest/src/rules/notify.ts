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
  async dispatch(tenantId: string, alert: AlertWithContext, notify: unknown): Promise<void> {
    const targets = parseTargets(notify);
    if (targets.length === 0) return;

    if (!this.config.ALERT_NOTIFY_ENABLED) {
      this.#stats.skipped += targets.length;
      return;
    }

    await Promise.all(targets.map((t) => this.#deliverOne(tenantId, alert, t)));
  }

  async #deliverOne(
    tenantId: string,
    alert: AlertWithContext,
    target: NotifyTarget,
  ): Promise<void> {
    const id = await this.#record(tenantId, alert.id, target);
    if (!id) return; // already recorded for this alert+channel+target

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
   * Retry what has not landed.
   *
   * Bounded by attempt count: an endpoint that has been down for a day should
   * stop being called, and the row keeps the last error so the reason survives.
   */
  async retryPending(): Promise<number> {
    let total = 0;
    // Per tenant: the sweep reads policy-scoped tables, so there is no single
    // query that can see every pending delivery.
    for (const tenant of await activeTenants()) {
      const rows = await withTenant({ tenantId: tenant.id }, async (db) => {
        const { rows } = await db.query<{
          id: string; alert_id: string; channel: string; target: string;
        }>(
          `SELECT n.id, n.alert_id, n.channel, n.target
             FROM alert_notifications n
             JOIN alerts a ON a.id = n.alert_id
            WHERE n.status <> 'delivered'
              AND n.channel = 'webhook'
              AND n.attempts < $1
              AND a.state <> 'resolved'
            ORDER BY n.created_at
            LIMIT 50`,
          [this.config.ALERT_WEBHOOK_MAX_ATTEMPTS],
        );
        return rows;
      });

      for (const row of rows) {
        const alert = await loadAlert(tenant.id, row.alert_id);
        if (alert) await this.#deliverWebhook(tenant.id, row.id, alert, row.target);
      }
      total += rows.length;
    }
    return total;
  }

  /** Insert the attempt row, or null if this destination is already recorded. */
  async #record(
    tenantId: string,
    alertId: string,
    target: NotifyTarget,
  ): Promise<string | null> {
    return withTenant({ tenantId }, async (db) => {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO alert_notifications (tenant_id, alert_id, channel, target, status)
         VALUES ($1, $2, $3::notification_channel, $4, 'pending')
         ON CONFLICT (alert_id, channel, target) DO NOTHING
         RETURNING id`,
        [tenantId, alertId, target.channel, target.target],
      );
      return rows[0]?.id ?? null;
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
