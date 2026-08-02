import { useCallback, useRef } from 'react'
import type { CompositionEvent, KeyboardEvent } from 'react'

const IME_PROCESSED_KEY_CODE = 229
const COMPOSITION_END_GRACE_MS = 50

/**
 * 统一识别输入法组合输入，兼容 macOS WebKit 在 compositionend 之后才派发
 * Enter keydown 的事件顺序。keyCode 229 虽已废弃，但仍是 WebKit/IME 的必要兜底。
 */
export const useImeCompositionGuard = <T extends HTMLElement>() => {
  const composingRef = useRef(false)
  const compositionEndedAtRef = useRef(Number.NEGATIVE_INFINITY)
  const suppressSubmitUntilRef = useRef(Number.NEGATIVE_INFINITY)

  const onCompositionStart = useCallback((_event: CompositionEvent<T>) => {
    composingRef.current = true
    compositionEndedAtRef.current = Number.NEGATIVE_INFINITY
  }, [])

  const onCompositionEnd = useCallback((_event: CompositionEvent<T>) => {
    composingRef.current = false
    compositionEndedAtRef.current = performance.now()
  }, [])

  const onBlur = useCallback(() => {
    composingRef.current = false
    compositionEndedAtRef.current = Number.NEGATIVE_INFINITY
    suppressSubmitUntilRef.current = Number.NEGATIVE_INFINITY
  }, [])

  const isImeEvent = useCallback((event: KeyboardEvent<T>) => {
    const now = performance.now()
    const nativeEvent = event.nativeEvent
    const justEndedComposition =
      now - compositionEndedAtRef.current <= COMPOSITION_END_GRACE_MS
    const handledByIme =
      composingRef.current
      || nativeEvent.isComposing
      || nativeEvent.keyCode === IME_PROCESSED_KEY_CODE
      || justEndedComposition

    if (handledByIme) {
      suppressSubmitUntilRef.current = now + COMPOSITION_END_GRACE_MS
    }
    return handledByIme
  }, [])

  const shouldBlockSubmit = useCallback(
    () => composingRef.current || performance.now() <= suppressSubmitUntilRef.current,
    [],
  )

  return {
    isImeEvent,
    onBlur,
    onCompositionEnd,
    onCompositionStart,
    shouldBlockSubmit,
  }
}
