export interface KeystrokeEvent {
  readonly dwellMs: number;   // how long key was held
  readonly flightMs: number;  // time from prev keyup to this keydown
  readonly questionId: string;
  readonly capturedAt: number; // performance.now()
}

export interface KeystrokeDynamicsSnapshot {
  readonly events: readonly KeystrokeEvent[];
  readonly avgDwellMs: number;
  readonly avgFlightMs: number;
  readonly suspiciousUniformity: boolean; // CV < 0.1 = likely bot/paste-then-type
  readonly wpm: number;
}

export function createKeystrokeDynamics(questionId: string) {
  const events: KeystrokeEvent[] = [];
  const keyDownTimes = new Map<string, number>();
  let lastKeyUpTime = -1;
  let charCount = 0;
  const startTime = performance.now();

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key.length === 1 || e.key === 'Backspace') {
      keyDownTimes.set(e.key + e.timeStamp.toString(), performance.now());
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    const downKey = e.key + e.timeStamp.toString();
    const downTime = [...keyDownTimes.entries()].find(([k]) => k.startsWith(e.key))?.[1];
    if (downTime === undefined) return;
    keyDownTimes.delete(downKey);

    const dwellMs = performance.now() - downTime;
    const flightMs = lastKeyUpTime >= 0 ? performance.now() - lastKeyUpTime : 0;
    lastKeyUpTime = performance.now();
    if (e.key.length === 1) charCount++;

    events.push({ dwellMs, flightMs, questionId, capturedAt: performance.now() });
    // Keep last 500 events
    if (events.length > 500) events.shift();
  }

  function snapshot(): KeystrokeDynamicsSnapshot {
    if (events.length < 5) {
      return { events: [...events], avgDwellMs: 0, avgFlightMs: 0, suspiciousUniformity: false, wpm: 0 };
    }
    const dwells = events.map((e) => e.dwellMs);
    const flights = events.filter((e) => e.flightMs > 0).map((e) => e.flightMs);
    const avgDwell = dwells.reduce((a, b) => a + b, 0) / dwells.length;
    const avgFlight = flights.length > 0 ? flights.reduce((a, b) => a + b, 0) / flights.length : 0;
    
    // Coefficient of variation — bots have CV < 0.1 (too uniform)
    const stdDwell = Math.sqrt(dwells.reduce((a, b) => a + (b - avgDwell) ** 2, 0) / dwells.length);
    const cv = avgDwell > 0 ? stdDwell / avgDwell : 1;
    const elapsedMin = (performance.now() - startTime) / 60_000;
    const wpm = elapsedMin > 0 ? Math.round((charCount / 5) / elapsedMin) : 0;

    return {
      events: [...events],
      avgDwellMs: Math.round(avgDwell),
      avgFlightMs: Math.round(avgFlight),
      suspiciousUniformity: cv < 0.1 && events.length > 20,
      wpm,
    };
  }

  return { onKeyDown, onKeyUp, snapshot, reset: () => { events.length = 0; charCount = 0; } };
}
