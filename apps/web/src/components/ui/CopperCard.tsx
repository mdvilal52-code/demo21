import type { HTMLAttributes, ReactNode } from 'react';

export function CopperCard({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div
      className={`rounded-card bg-copper-gradient p-5 text-ink-900 shadow-[0_14px_34px_rgba(0,0,0,0.38)] [box-shadow:inset_0_1px_0_rgba(255,255,255,0.35)] ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
