export function Monogram() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-copper-300/60 bg-emerald-800/60 text-copper-100"
    >
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M5 19V5l14 14V5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}
