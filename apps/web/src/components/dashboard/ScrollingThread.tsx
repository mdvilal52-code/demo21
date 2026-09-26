'use client';

import { useEffect, useRef, type ReactNode } from 'react';

const NEAR_BOTTOM_PX = 80;

/**
 * A scrolling box that opens at the newest message and follows new ones —
 * unless the reader has scrolled up to read history, in which case an
 * auto-refresh never yanks them back down.
 */
export function ScrollingThread({ children }: { children: ReactNode }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const box = boxRef.current;
    if (box && followRef.current) box.scrollTop = box.scrollHeight;
  });

  return (
    <div
      ref={boxRef}
      onScroll={(event) => {
        const box = event.currentTarget;
        followRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < NEAR_BOTTOM_PX;
      }}
      className="max-h-[560px] overflow-y-auto pr-1"
    >
      {children}
    </div>
  );
}
