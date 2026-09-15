import type { ButtonHTMLAttributes } from 'react';

type Variant = 'copper' | 'outline';

export function PillButton({
  variant = 'copper',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base =
    'inline-flex items-center justify-center rounded-pill px-6 py-3 text-sm font-medium tracking-wide transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-copper-300';
  const variants: Record<Variant, string> = {
    copper: 'bg-copper-gradient text-ink-900 hover:brightness-105',
    outline: 'border border-copper-300 text-copper-100 hover:bg-emerald-700/40',
  };
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />;
}
