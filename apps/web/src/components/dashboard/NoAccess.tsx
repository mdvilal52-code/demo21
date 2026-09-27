import { GlassCard } from '../ui/GlassCard';

/** Shown instead of a screen the signed-in role has no permission for (the API would refuse it too). */
export function NoAccess({ section }: { section: string }) {
  return (
    <div className="mx-auto max-w-2xl py-8">
      <GlassCard>
        <h1 className="font-display text-lg uppercase tracking-[0.14em] text-cream-50">
          {section}
        </h1>
        <p className="mt-3 text-sm text-cream-50/70" role="status">
          Your role does not have access to this section. Ask an administrator if you need it.
        </p>
      </GlassCard>
    </div>
  );
}
