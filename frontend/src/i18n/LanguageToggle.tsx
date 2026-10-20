import { Languages } from 'lucide-react';
import { LANGS, useT } from './index';

/** Cycles between the available languages. English ↔ বাংলা today; works for any number in LANGS. */
export function LanguageToggle({ className = '' }: { className?: string }) {
  const { lang, setLang } = useT();
  const i = LANGS.findIndex((l) => l.code === lang);
  const next = LANGS[(i + 1) % LANGS.length];
  return (
    <button
      type="button"
      onClick={() => setLang(next.code)}
      aria-label={`Language: ${LANGS[i].label}. Switch to ${next.label}`}
      title={LANGS[i].label}
      className={`inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-ink-2 hover:bg-panel-2 hover:text-ink ${className}`}
    >
      <Languages aria-hidden className="size-[18px]" />
      <span>{next.label}</span>
    </button>
  );
}
