type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-success/15 text-success border-success/40',
  warning: 'bg-warning/15 text-warning border-warning/40',
  danger: 'bg-danger/15 text-danger border-danger/40',
  neutral: 'bg-white/10 text-cream-50 border-white/20',
};

export function StatusChip({ tone, children }: { tone: Tone; children: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-pill border px-3 py-1 text-xs font-medium uppercase tracking-wide ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
