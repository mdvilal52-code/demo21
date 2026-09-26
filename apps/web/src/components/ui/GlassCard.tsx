import type { HTMLAttributes, ReactNode } from 'react';

export function GlassCard({
  children,
  className = '',
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div
      className={`rounded-card border border-white/10 bg-emerald-700/55 p-5 shadow-[0_14px_34px_rgba(0,0,0,0.38)] backdrop-blur-sm ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
