// Spring easings for src/motion.css: the step response of a damped spring
// (mass 1), sampled into CSS linear(). Run with node, paste the output into :root.
function spring(k, c, samples) {
  const w0 = Math.sqrt(k), z = c / (2 * w0);
  const x = (t) => {
    if (z < 1) { const wd = w0 * Math.sqrt(1 - z * z); return 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t)); }
    return 1 - (1 + w0 * t) * Math.exp(-w0 * t);
  };
  // Settle when the envelope is within 0.4% of rest.
  let T = 0.01; while (true) { let ok = true; for (let t = T; t < T + 0.3; t += 0.005) if (Math.abs(1 - x(t)) > 0.004) { ok = false; break; } if (ok) break; T += 0.01; }
  const pts = []; let peak = 0;
  for (let i = 0; i <= samples; i++) { const v = i === samples ? 1 : x((i / samples) * T); peak = Math.max(peak, v); pts.push(+v.toFixed(4)); }
  return { css: `linear(${pts.join(', ')})`, ms: Math.round(T * 1000), overshoot: +((peak - 1) * 100).toFixed(1) };
}
const defs = { snappy: [380, 30, 32], bouncy: [260, 17, 48], soft: [170, 26, 28], wobbly: [200, 12, 56] };
for (const [name, [k, c, n]] of Object.entries(defs)) {
  const s = spring(k, c, n);
  console.log(`  /* k=${k} c=${c}: ${s.ms}ms, ${s.overshoot}% overshoot */`);
  console.log(`  --spring-${name}: ${s.css};`);
  console.log(`  --spring-${name}-dur: ${s.ms}ms;`);
}
