import { MoreHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { useT } from '../i18n';
import { Logo } from './Logo';
import { navFor } from './nav';

const linkClass = ({ isActive }: { isActive: boolean }) =>
  `flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors ${
    isActive ? 'bg-teal-wash text-teal-strong' : 'text-ink-2 hover:bg-panel hover:text-ink'
  }`;

/** Desktop: a label rail on the left. Below lg it becomes the bottom bar (4 items + More). */
export function Sidebar() {
  const { user } = useAuth();
  const { t } = useT();
  const items = navFor(user?.role);
  return (
    <>
      <nav
        aria-label="Main"
        className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-rule bg-panel-2 lg:flex print:hidden"
      >
        <div className="flex h-14 items-center border-b border-rule px-4">
          <Logo />
        </div>
        <ul className="flex flex-col gap-0.5 p-3">
          {items.map(({ to, labelKey, icon: Icon }) => (
            <li key={to}>
              <NavLink to={to} end={to === '/'} className={linkClass}>
                <Icon aria-hidden className="size-[18px] shrink-0" />
                {t(labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <BottomBar />
    </>
  );
}

function BottomBar() {
  const { user } = useAuth();
  const { t } = useT();
  const items = navFor(user?.role);
  const primary = items.filter((i) => i.primary);
  const more = items.filter((i) => !i.primary);
  const { pathname } = useLocation();
  // the menu belongs to the page it was opened on: navigating closes it
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const setOpen = (v: boolean | ((o: boolean) => boolean)) =>
    setOpenOn((typeof v === 'function' ? v(open) : v) ? pathname : null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node))
        setOpenOn(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const tab = ({ isActive }: { isActive: boolean }) =>
    `flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold ${
      isActive ? 'text-teal-strong' : 'text-ink-2'
    }`;

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-panel pb-[env(safe-area-inset-bottom)] lg:hidden print:hidden"
    >
      <div className="flex">
        {primary.map(({ to, labelKey, icon: Icon }) => (
          <NavLink key={to} to={to} end={to === '/'} className={tab}>
            <Icon aria-hidden className="size-5" />
            {t(labelKey)}
          </NavLink>
        ))}
        {more.length > 0 && (
          <div ref={menuRef} className="relative flex flex-1">
            <button
              type="button"
              aria-expanded={open}
              aria-haspopup="menu"
              onClick={() => setOpen((o) => !o)}
              className={`flex min-h-14 flex-1 cursor-pointer flex-col items-center justify-center gap-0.5 text-[0.7rem] font-semibold ${
                more.some((m) => pathname.startsWith(m.to)) ? 'text-teal-strong' : 'text-ink-2'
              }`}
            >
              <MoreHorizontal aria-hidden className="size-5" />
              {t('nav.more')}
            </button>
            {open && (
              <ul
                role="menu"
                className="absolute right-2 bottom-[calc(100%+8px)] w-56 rounded-[var(--radius-label)] border border-rule bg-panel p-1.5 shadow-[0_12px_32px_rgb(15_27_42/0.18)]"
              >
                {more.map(({ to, labelKey, icon: Icon }) => (
                  <li key={to} role="none">
                    <NavLink role="menuitem" to={to} className={linkClass}>
                      <Icon aria-hidden className="size-[18px]" />
                      {t(labelKey)}
                    </NavLink>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
