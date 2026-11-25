export const getAbortReason = (signal: AbortSignal): unknown =>
  'reason' in signal ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw getAbortReason(signal)
  }
}

/** A request deadline that also works in browsers with only AbortController. */
export const abortTimeout = (milliseconds: number, parent?: AbortSignal): AbortSignal => {
  if (typeof AbortSignal.timeout === 'function' && (!parent || typeof AbortSignal.any === 'function')) {
    const deadline = AbortSignal.timeout(milliseconds)
    return parent ? AbortSignal.any([parent, deadline]) : deadline
  }

  const controller = new AbortController()
  const end = (reason: unknown) => {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
    controller.abort(reason)
  }
  const onParentAbort = () => end(parent && getAbortReason(parent))
  const timer = setTimeout(
    () => end(new DOMException('The operation timed out.', 'TimeoutError')),
    milliseconds
  )
  if (parent?.aborted) onParentAbort()
  else parent?.addEventListener('abort', onParentAbort, { once: true })
  return controller.signal
}
