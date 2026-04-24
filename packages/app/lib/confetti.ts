'use client';

import confetti from 'canvas-confetti';

let lastFiredAt = 0;

export function fireWinConfetti() {
  // Throttle to once per second at most
  const now = Date.now();
  if (now - lastFiredAt < 1000) return;
  lastFiredAt = now;

  const defaults = {
    origin: { y: 0.6 },
    spread: 80,
    startVelocity: 45,
    zIndex: 9999,
  };

  confetti({
    ...defaults,
    particleCount: 80,
    colors: ['#10b981', '#3b82f6', '#f59e0b', '#ec4899'],
  });

  setTimeout(() => {
    confetti({
      ...defaults,
      particleCount: 40,
      angle: 60,
      spread: 55,
      origin: { x: 0, y: 0.7 },
    });
    confetti({
      ...defaults,
      particleCount: 40,
      angle: 120,
      spread: 55,
      origin: { x: 1, y: 0.7 },
    });
  }, 200);
}
