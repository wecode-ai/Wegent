import { useCallback, useLayoutEffect, useRef } from 'react'

export function useStableEvent<TArgs extends unknown[], TResult>(
  handler: (...args: TArgs) => TResult
): (...args: TArgs) => TResult {
  const handlerRef = useRef(handler)

  useLayoutEffect(() => {
    handlerRef.current = handler
  }, [handler])

  return useCallback((...args: TArgs) => handlerRef.current(...args), [])
}
