type Tone = 'default' | 'success' | 'danger';

const VALUE_TONE: Record<Tone, string> = {
  default: 'text-cream-50',
  success: 'text-success',
  danger: 'text-danger',
};

/** KPI tile (docs/DESIGN-SYSTEM.md): micro label, large tabular number, one line of context. */
export function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-card border border-white/10 bg-emerald-700/55 p-5 shadow-[0_14px_34px_rgba(0,0,0,0.38)]">
      <p className="text-xs uppercase tracking-[0.14em] text-cream-50/70">{label}</p>
      <p className={`mt-2 font-display text-3xl font-semibold tabular-nums ${VALUE_TONE[tone]}`}>
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-cream-50/60">{hint}</p>}
    </div>
  );
}
