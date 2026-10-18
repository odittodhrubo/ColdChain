import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Loader2, LogOut, Monitor, Moon, Radio, RefreshCw, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';
import { ROLE_LABEL } from '../auth/permissions';
import { api } from '../lib/api';
import { useConnection } from '../realtime/RealtimeProvider';
import { useTheme, type ThemeChoice } from '../theme/ThemeProvider';
import { VvmMark } from '../ui/VvmMark';
import { Logo } from './Logo';

interface Page {
  total: number;
}

/** Global state of the cold room in one pill: all clear, or how many alerts are open and how severe. */
function StatusPill() {
  const { data } = useQuery({
    queryKey: ['alerts', 'summary'],
    queryFn: async ({ signal }) => {
      const [active, critical] = await Promise.all([
        api<Page>('/api/alerts?status=active&pageSize=1', { signal }),
        api<Page>('/api/alerts?status=active&severity=CRITICAL&pageSize=1', { signal }),
      ]);
      return { active: active.total, critical: critical.total };
    },
  });
  if (!data) return <span className="h-9 w-40 rounded-full bg-panel-2" aria-hidden />;
  const status = data.critical > 0 ? 'BREACH' : data.active > 0 ? 'WARNING' : 'SAFE';
  const text =
    data.active === 0
      ? 'All fridges safe'
      : `${data.active} open alert${data.active === 1 ? '' : 's'}${data.critical ? `, ${data.critical} critical` : ''}`;
  const short =
    data.active === 0
      ? 'All safe'
      : `${data.active} alert${data.active === 1 ? '' : 's'}${data.critical ? ` · ${data.critical} crit.` : ''}`;
  const ink = status === 'SAFE' ? 'var(--safe)' : status === 'WARNING' ? 'var(--warning)' : 'var(--breach)';
  return (
    <Link
      to="/alerts"
      aria-label={text}
      className="figures inline-flex min-h-9 min-w-0 items-center gap-2 rounded-full border px-3 text-sm font-semibold"
      style={{
        color: ink,
        borderColor: `color-mix(in oklab, ${ink} 40%, transparent)`,
        backgroundColor: `color-mix(in oklab, ${ink} 9%, var(--panel))`,
      }}
    >
      <VvmMark status={status} size={20} />
      <span aria-hidden className="truncate sm:hidden">
        {short}
      </span>
      <span aria-hidden className="hidden truncate sm:inline">
        {text}
      </span>
    </Link>
  );
}

const CONNECTION = {
  live: { label: 'Live', ink: 'var(--safe)', icon: Radio, help: 'Realtime updates are connected' },
  polling: {
    label: 'Polling every 5 s',
    ink: 'var(--warning)',
    icon: RefreshCw,
    help: 'Realtime is unavailable; refreshing every 5 seconds',
  },
  connecting: {
    label: 'Connecting',
    ink: 'var(--offline)',
    icon: Loader2,
    help: 'Opening the realtime connection',
  },
} as const;

function ConnectionIndicator() {
  const c = CONNECTION[useConnection()];
  const Icon = c.icon;
  // a distinct glyph per state, so the state never rests on colour alone (the word joins it from sm up)
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-2" title={c.help}>
      <Icon aria-hidden className="size-4" style={{ color: c.ink }} />
      <span className="sr-only sm:not-sr-only">{c.label}</span>
    </span>
  );
}

const THEMES: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: 'system', label: 'System theme', icon: Monitor },
  { value: 'light', label: 'Light theme', icon: Sun },
  { value: 'dark', label: 'Dark theme', icon: Moon },
];

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const i = THEMES.findIndex((t) => t.value === choice);
  const current = THEMES[i];
  const nextTheme = THEMES[(i + 1) % THEMES.length];
  const Icon = current.icon;
  return (
    <button
      type="button"
      onClick={() => setChoice(nextTheme.value)}
      aria-label={`${current.label}. Switch to ${nextTheme.label.toLowerCase()}`}
      title={current.label}
      className="grid size-10 cursor-pointer place-items-center rounded-md text-ink-2 hover:bg-panel-2 hover:text-ink"
    >
      <Icon aria-hidden className="size-[18px]" />
    </button>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node))
        setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  if (!user) return null;
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left hover:bg-panel-2"
      >
        <span className="grid size-8 place-items-center rounded-full bg-teal-wash text-xs font-bold text-teal-strong">
          {initials}
        </span>
        <span className="hidden flex-col leading-tight md:flex">
          <span className="text-sm font-semibold text-ink">{user.name}</span>
          <span className="text-xs text-ink-3">{ROLE_LABEL[user.role]}</span>
        </span>
        <ChevronDown aria-hidden className="size-4 text-ink-3" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-2 w-60 rounded-[var(--radius-label)] border border-rule bg-panel p-1.5 shadow-[0_12px_32px_rgb(15_27_42/0.18)]"
        >
          <div className="border-b border-rule px-3 pt-2 pb-3">
            <p className="text-sm font-semibold text-ink">{user.name}</p>
            <p className="text-sm text-ink-2">{user.email}</p>
            <p className="mt-1 text-xs font-semibold text-teal-strong">{ROLE_LABEL[user.role]}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => logout('manual')}
            className="mt-1 flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-md px-3 text-sm font-medium text-ink hover:bg-panel-2"
          >
            <LogOut aria-hidden className="size-4" />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function TopBar() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-rule bg-panel px-4 lg:px-6">
      {/* phones give this width to the status pill; the bottom bar and login carry the brand there */}
      <span className="hidden sm:inline lg:hidden">
        <Logo compact />
      </span>
      <StatusPill />
      <div className="ml-auto flex items-center gap-1 sm:gap-3">
        <ConnectionIndicator />
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
