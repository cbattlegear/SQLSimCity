// Self-contained so Playwright can evaluate it without importing helpers into the page.
export function waitForSceneIdle(measure = window.__measure, { quietFrames = 3, timeoutMs = 60000 } = {}) {
  if (!Number.isInteger(quietFrames) || quietFrames < 1 || !Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Idle sampling needs a positive frame count and bounded timeout')
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const initialCallbacks = measure.rafTotal
    let previousCallbacks = initialCallbacks
    let quiet = 0
    let frames = 0
    let finished = false
    const timer = setTimeout(() => {
      finished = true
      reject(new Error(`Scene never became idle: ${measure.rafTotal - initialCallbacks} application callbacks during ${frames} sampled frames`))
    }, timeoutMs)
    const sample = () => {
      if (finished) return
      frames += 1
      quiet = measure.rafTotal === previousCallbacks ? quiet + 1 : 0
      previousCallbacks = measure.rafTotal
      if (quiet >= quietFrames) {
        finished = true
        clearTimeout(timer)
        resolve({ frames, callbacks: measure.rafTotal - initialCallbacks, ms: performance.now() - started })
      } else measure.sampleFrame(sample)
    }
    measure.sampleFrame(sample)
  })
}
