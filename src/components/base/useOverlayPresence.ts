import { useLayoutEffect, useRef, useState } from 'react'

// 与 global.css 中的浮层退场时长一致。
const EXIT_DURATION = 140

export const useOverlayPresence = <T>(visible: T | null, onExited?: () => void) => {
  const [previous, setPrevious] = useState(visible)
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited
  const closing = visible === null && previous !== null

  useLayoutEffect(() => {
    if (!closing) {
      setPrevious(visible)
      return
    }
    const finish = () => {
      setPrevious(null)
      onExitedRef.current?.()
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      finish()
      return
    }
    const timeout = window.setTimeout(finish, EXIT_DURATION)
    return () => window.clearTimeout(timeout)
  }, [closing, visible])

  return {
    content: visible ?? previous,
    closing,
    exitProps: {
      'data-closing': closing,
      'aria-hidden': closing || undefined,
      inert: closing ? '' : undefined,
    },
  }
}
