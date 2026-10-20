import { useT } from '../i18n';
import { STATUS, type Status } from './status';
import { VvmMark } from './VvmMark';

/** Status as colour + VVM glyph + word, never colour alone. DISCARD carries the strike pattern. */
export function StatusChip({
  status,
  used,
  size = 'md',
  className = '',
}: {
  status: Status;
  used?: number;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { t } = useT();
  const meta = STATUS[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border font-semibold whitespace-nowrap ${
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm'
      } ${status === 'DISCARD' ? 'strike-pattern' : ''} ${className}`}
      style={{
        color: meta.ink,
        backgroundColor: meta.wash,
        borderColor: `color-mix(in oklab, ${meta.ink} 35%, transparent)`,
      }}
      title={meta.description}
    >
      <VvmMark status={status} used={used} size={size === 'sm' ? 13 : 15} />
      {t(`status.${status}`)}
    </span>
  );
}
