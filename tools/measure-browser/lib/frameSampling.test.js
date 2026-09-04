import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitForSceneIdle } from './frameSampling.js'

function sampler() {
  const queue = []
  const measure = { rafTotal: 0, sampleFrame: callback => queue.push(callback) }
  return {
    measure, queue,
    frame(callbacks = 0) {
      measure.rafTotal += callbacks
      assert(queue.length > 0, 'The sampler must request an actual native frame')
      queue.shift()()
    },
  }
}

test('waits through residual application work and requires consecutive quiet native frames', async () => {
  const rig = sampler()
  const idle = waitForSceneIdle(rig.measure)
  rig.frame(1)
  rig.frame()
  rig.frame()
  rig.frame(1)
  rig.frame()
  rig.frame()
  assert.equal(rig.queue.length, 1, 'A renewed callback must reset the quiet-frame budget')
  rig.frame()
  const result = await idle
  assert.equal(result.callbacks, 2)
  assert.equal(result.frames, 7)
  assert.equal(rig.queue.length, 0)
})

test('sampling callbacks do not become application callbacks or outlive successful sampling', async () => {
  const rig = sampler()
  const idle = waitForSceneIdle(rig.measure)
  rig.frame()
  rig.frame()
  rig.frame()
  assert.equal((await idle).callbacks, 0)
  assert.equal(rig.measure.rafTotal, 0)
  assert.equal(rig.queue.length, 0)
})

test('an endlessly scheduled application callback fails the bounded wait rather than passing idle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const rig = sampler()
  const idle = waitForSceneIdle(rig.measure, { timeoutMs: 100 })
  const failure = assert.rejects(idle, /Scene never became idle: 10 application callbacks during 10 sampled frames/)
  for (let frame = 0; frame < 10; frame++) rig.frame(1)
  t.mock.timers.tick(100)
  await failure
  rig.frame()
  assert.equal(rig.queue.length, 0, 'A timed-out sampler must not keep scheduling')
})

test('rejects sample settings that could pass without evidence or wait without a bound', () => {
  for (const options of [{ quietFrames: 0 }, { quietFrames: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Infinity }])
    assert.throws(() => waitForSceneIdle(sampler().measure, options), /positive frame count and bounded timeout/)
})
