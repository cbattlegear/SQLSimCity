/** Percentile of an already-unsorted sample, nearest-rank. */
export function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const rank = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[rank]
}

export const median = (values) => percentile(values, 50)
export const mean = (values) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
export const max = (values) => (values.length === 0 ? null : Math.max(...values))

export const round = (value, places = 2) =>
  value === null || value === undefined ? null : Number(value.toFixed(places))

export function summarize(values, places = 2) {
  return {
    n: values.length,
    median: round(median(values), places),
    mean: round(mean(values), places),
    p95: round(percentile(values, 95), places),
    max: round(max(values), places),
  }
}

/**
 * Splits a frame sample into the first frame and the rest.
 *
 * The first frame after a camera starts moving carries whatever the application rebuilt in
 * response — most visibly shader compilation for materials that had never been drawn before
 * — so folding it into a per-frame average attributes a one-off to every frame. It is
 * reported *beside* the steady state rather than discarded, because on this scene it turned
 * out to be the largest number in the run and a rule that silently dropped it would have
 * hidden the finding.
 *
 * Nothing is dropped when the sample is too small to spare it. A slice that can consume the
 * whole sample is exactly the mistake that produced a one-frame "median" on the first run of
 * this harness.
 */
export function splitWarmup(frames) {
  if (frames.length <= 2) return { warmup: [], steady: frames }
  return { warmup: frames.slice(0, 1), steady: frames.slice(1) }
}

export function frameReport(frames) {
  const { warmup, steady } = splitWarmup(frames)
  const cpu = steady.map(frame => frame.cpuMs)
  const gaps = steady.map(frame => frame.sinceLast).filter(value => typeof value === 'number')
  const calls = steady.map(frame => frame.calls)
  const offCalls = steady.map(frame => frame.offCalls)
  const tris = steady.map(frame => frame.tris)
  const offTris = steady.map(frame => frame.offTris)
  const offMs = steady.map(frame => frame.offMs ?? 0)
  const medianGap = median(gaps)
  return {
    frames: steady.length,
    sampled: frames.length,
    firstFrameCpuMs: round(warmup[0]?.cpuMs ?? null, 1),
    cpuMsPerFrame: summarize(cpu),
    shadowPassMsPerFrame: summarize(offMs),
    frameIntervalMs: summarize(gaps),
    fps: medianGap ? round(1000 / medianGap, 1) : null,
    drawCalls: { median: median(calls), max: max(calls) },
    offscreenDrawCalls: { median: median(offCalls), max: max(offCalls) },
    trianglesPerFrame: { median: median(tris), max: max(tris) },
    offscreenTriangles: { median: median(offTris), max: max(offTris) },
  }
}
