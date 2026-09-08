import type { Metadata } from 'next';
import Link from 'next/link';

import './globals.css';
import { NavLinks } from '@/components/nav-links';
import { bootstrap } from '@/services/bootstrap';

export const metadata: Metadata = {
  title: 'Dev Cockpit',
  description: 'Local-first AI software-engineering orchestration.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Applies migrations and reconciles runs interrupted by a restart. Runs once
  // per server process; the layout is the earliest reliable server entry point.
  bootstrap();

  return (
    <html lang="en">
      <body>
        <div className="flex h-screen overflow-hidden">
          <aside className="flex w-52 shrink-0 flex-col border-r border-line bg-surface">
            <div className="flex h-12 items-center gap-2 border-b border-line px-3.5">
              <span
                aria-hidden
                className="grid h-5 w-5 place-items-center rounded bg-accent text-[11px] font-bold text-[#04101f]"
              >
                D
              </span>
              <Link href="/runs" className="text-[13.5px] font-semibold tracking-tight">
                Dev Cockpit
              </Link>
            </div>

            <nav className="flex-1 space-y-0.5 p-2" aria-label="Primary">
              <NavLinks />
            </nav>

            <div className="border-t border-line px-3.5 py-2.5 text-[11px] leading-relaxed text-ink-faint">
              <p>Local only — bound to 127.0.0.1.</p>
              <p className="mt-1">The orchestrator decides readiness, not the agent.</p>
            </div>
          </aside>

          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
