'use client';

import type { AlertWithContext } from '@dtwin/types';
import { SEVERITY_COLOR } from '@/lib/colors';

const SEVERITY_ICON: Record<string, string> = {
  critical: '‼',
  warning: '▲',
  info: '•',
};

/**
 * Severity is carried by an icon and a written label as well as colour. Two of
 * the four status steps sit below 3:1 on a light surface by design, so colour is
 * never allowed to be the only channel.
 */
export function AlertList({
  alerts, onSelectZone,
}: {
  alerts: AlertWithContext[];
  onSelectZone: (zoneId: string) => void;
}) {
  if (alerts.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
        No open alerts.
      </div>
    );
  }

  return (
    <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
      {alerts.map((alert) => (
        <li key={alert.id}>
          <button
            type="button"
            className="w-full px-3 py-2 text-left hover:opacity-80"
            onClick={() => alert.zoneId && onSelectZone(alert.zoneId)}
          >
            <div className="flex items-baseline gap-2">
              <span aria-hidden style={{ color: SEVERITY_COLOR[alert.severity] }}>
                {SEVERITY_ICON[alert.severity] ?? '•'}
              </span>
              <span className="text-xs font-medium uppercase tracking-wide"
                    style={{ color: SEVERITY_COLOR[alert.severity] }}>
                {alert.severity}
              </span>
              {alert.state === 'acknowledged' && (
                <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                  acknowledged
                </span>
              )}
            </div>
            <div className="mt-0.5 text-sm">{alert.message}</div>
            <div className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {[alert.floorName, alert.zoneName, alert.equipmentTag]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}
