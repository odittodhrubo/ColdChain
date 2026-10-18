import { useState } from 'react';
import { STATUS, type Status } from './status';

/**
 * The vaccine vial monitor mark: a square inside a circle. The square darkens as heat budget is used, exactly as
 * a nurse reads the real label: lighter than the ring = usable, matching it = at risk, darker and struck = discard.
 * It pulses once when its status changes (never on first render, so lists and route changes stay still).
 */
export function VvmMark({
  status,
  used,
  size = 16,
  title,
}: {
  status: Status;
  used?: number; // 0..1, defaults to the status' typical fill
  size?: number;
  title?: string; // set when the mark stands alone; otherwise it is decorative next to its word
}) {
  const meta = STATUS[status];
  // previous-render state (React's documented pattern): a change of status, not a mount, starts the pulse
  const [seen, setSeen] = useState(status);
  const [pulse, setPulse] = useState(false);
  if (seen !== status) {
    setSeen(status);
    setPulse(true);
  }
  const fill = Math.min(1, Math.max(0, used ?? meta.used));
  return (
    <svg
      className={`shrink-0 ${pulse ? 'vvm-pulse' : ''}`}
      onAnimationEnd={() => setPulse(false)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <circle cx="12" cy="12" r="10" fill="none" stroke={meta.ink} strokeWidth="2.25" />
      {status === 'OFFLINE' ? (
        <rect
          x="7.5"
          y="7.5"
          width="9"
          height="9"
          fill="none"
          stroke={meta.ink}
          strokeWidth="1.5"
          strokeDasharray="2 2"
        />
      ) : (
        <rect x="7.5" y="7.5" width="9" height="9" fill={meta.ink} fillOpacity={0.14 + 0.86 * fill} />
      )}
      {status === 'DISCARD' && <line x1="5" y1="19" x2="19" y2="5" stroke="var(--panel)" strokeWidth="2" />}
    </svg>
  );
}
