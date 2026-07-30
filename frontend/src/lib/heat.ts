/**
 * Curve progress → a colour on the heat ramp.
 *
 * Progress toward graduation is the most decision-relevant number on a card, so the board encodes
 * it twice: bar length AND colour. Scanning a grid of forty cards, colour is read before any digit
 * is parsed, which is what makes the board legible at a glance rather than a wall of meters.
 *
 * The ramp deliberately warms rather than reddening: red would read as danger, and a curve nearing
 * graduation is the opposite of dangerous - it is the thing most worth looking at.
 *
 * Returns a `var(--heat-N)` reference rather than a hex value so the palette stays defined in one
 * place (styles.css) and theming stays a CSS concern.
 */
export function heatColor(progressBps: number): string {
  const pct = clampBps(progressBps) / 100
  if (pct >= 90) return 'var(--heat-4)'
  if (pct >= 75) return 'var(--heat-3)'
  if (pct >= 50) return 'var(--heat-2)'
  if (pct >= 25) return 'var(--heat-1)'
  return 'var(--heat-0)'
}

/** Progress as a 0..100 percentage, clamped. */
export function heatPercent(progressBps: number): number {
  return clampBps(progressBps) / 100
}

/**
 * Bars below this are widened to a visible stub. A curve with a real but tiny position (0.3% on
 * RUGPRF) would otherwise render as an empty track, indistinguishable from a launch that has never
 * traded - two genuinely different states that must not look identical.
 */
const MIN_VISIBLE_PCT = 1.5

/** Bar width for rendering: preserves the "genuinely zero" state while keeping tiny values visible. */
export function meterWidthPercent(progressBps: number): number {
  const pct = heatPercent(progressBps)
  if (pct === 0) return 0
  return Math.max(MIN_VISIBLE_PCT, pct)
}

function clampBps(bps: number): number {
  if (!Number.isFinite(bps)) return 0
  return Math.min(10_000, Math.max(0, bps))
}
