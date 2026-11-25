import assert from 'node:assert/strict'
import { test } from 'node:test'
import { abortTimeout, getAbortReason, throwIfAborted } from '../src/utils/abort.js'

test('preserves explicit abort reasons and supports older signals without a reason', () => {
  const scope = new AbortController()
  const cause = new Error('Canceled by user')
  assert.doesNotThrow(() => throwIfAborted(scope.signal))
  scope.abort(cause)
  assert.throws(() => throwIfAborted(scope.signal), (error) => error === cause)
  const olderSignal = { aborted: true } as AbortSignal
  assert.equal((getAbortReason(olderSignal) as DOMException).name, 'AbortError')
  assert.throws(() => throwIfAborted(olderSignal), { name: 'AbortError' })
})

test('cancels modern and fallback request deadlines when the parent aborts', async () => {
  const expected = new DOMException('Parent canceled', 'AbortError')
  for (const useFallback of [false, true]) {
    const methods = ['any', 'timeout'] as const
    const descriptors = methods.map((key) => Object.getOwnPropertyDescriptor(AbortSignal, key))
    if (useFallback) {
      for (const key of methods) Object.defineProperty(AbortSignal, key, { value: undefined, configurable: true })
    }
    try {
      const controller = new AbortController()
      const child = abortTimeout(10000, controller.signal)
      assert.equal(child.aborted, false)
      controller.abort(expected)
      assert.equal(child.reason, expected)
      assert.equal(abortTimeout(10000, controller.signal).reason, expected)
      if (useFallback) {
        const deadline = abortTimeout(5)
        await new Promise<void>((resolve) => deadline.addEventListener('abort', () => resolve(), { once: true }))
        assert.equal(deadline.reason.name, 'TimeoutError')
      }
    } finally {
      for (let i = 0; i < methods.length; i++) {
        if (descriptors[i]) Object.defineProperty(AbortSignal, methods[i], descriptors[i]!)
      }
    }
  }
})
