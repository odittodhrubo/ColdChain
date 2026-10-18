/** ColdChain mark: the vial monitor's ring and square in teal ink, the square mostly unspent. */
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5 text-ink">
      <svg width="26" height="26" viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="10" fill="none" stroke="var(--teal)" strokeWidth="2.4" />
        <rect x="7.6" y="7.6" width="8.8" height="8.8" fill="var(--teal)" fillOpacity="0.28" />
        <rect x="7.6" y="12.6" width="8.8" height="3.8" fill="var(--teal)" />
      </svg>
      {!compact && <span className="text-[1.05rem] font-bold tracking-[-0.01em]">ColdChain</span>}
    </span>
  );
}
