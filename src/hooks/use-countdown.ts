"use client";

import { useEffect, useState } from "react";

/** Seconds remaining until `until` (epoch ms), updated every second. */
export function useCountdown(until: number | null | undefined): number {
  const compute = () =>
    until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0;
  const [remaining, setRemaining] = useState(compute);
  useEffect(() => {
    setRemaining(compute());
    if (!until) return;
    const timer = window.setInterval(() => {
      const next = compute();
      setRemaining(next);
      if (next <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [until]);
  return remaining;
}
