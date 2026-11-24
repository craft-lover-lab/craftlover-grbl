/**
 * Estimated duration of every G-code line (seconds), from the distance it moves and its feed
 * rate. G0 uses `travelSpeed`; G1/G2/G3 use the modal F value. Comments, blank lines and
 * non-motion commands take 0 s. Acceleration is ignored, so real jobs run somewhat longer —
 * the progress display corrects for that with the measured pace.
 */
export function estimateLineTimes(lines: string[], travelSpeed: number): number[] {
  let x = 0;
  let y = 0;
  let feed = 1000;
  let motion = 0; // 0 = G0, 1 = G1 …
  return lines.map((raw) => {
    const l = raw.replace(/;.*$/, '').toUpperCase();
    if (!l.trim()) return 0;
    const g = l.match(/\bG0*([0-3])\b/);
    if (g) motion = +g[1];
    const f = l.match(/F([\d.]+)/);
    if (f) feed = Math.max(1, parseFloat(f[1]));
    if (/\bG(10|92|53|4)\b/.test(l)) return 0;
    const mx = l.match(/X(-?[\d.]+)/);
    const my = l.match(/Y(-?[\d.]+)/);
    if (!mx && !my) return 0;
    const nx = mx ? parseFloat(mx[1]) : x;
    const ny = my ? parseFloat(my[1]) : y;
    const d = Math.hypot(nx - x, ny - y);
    x = nx;
    y = ny;
    return (d / (motion === 0 ? travelSpeed : feed)) * 60;
  });
}

/**
 * Cumulative estimated time indexed by the number of lines the controller has acknowledged.
 * Lines are filtered exactly like the sender does (comments and blanks are never sent).
 */
export function progressPlan(lines: string[], travelSpeed: number): { cum: number[]; total: number } {
  const times = estimateLineTimes(lines, travelSpeed);
  const cum: number[] = [0];
  lines.forEach((l, i) => {
    if (l.replace(/;.*$/, '').trim()) cum.push(cum[cum.length - 1] + times[i]);
  });
  return { cum, total: cum[cum.length - 1] };
}

/**
 * Elapsed and remaining time for a running job. The estimate is scaled by the pace measured
 * so far (real moves are slower than the pure distance/feed estimate because of acceleration),
 * once enough of the job has run for that to be meaningful.
 */
export function jobTiming(plan: { cum: number[]; total: number }, acked: number, elapsedS: number) {
  const done = plan.cum[Math.max(0, Math.min(acked, plan.cum.length - 1))];
  const frac = plan.total > 0 ? done / plan.total : 0;
  const pace = frac > 0.03 && done > 1 ? Math.min(5, Math.max(0.5, elapsedS / done)) : 1;
  return { frac, remainingS: Math.max(0, (plan.total - done) * pace) };
}
