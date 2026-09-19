import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'DTwin — Corniche Tower',
  description: 'Digital twin: live telemetry, alerts and energy simulation',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
