/** React Native's AbortSignal supports aborted and events, not throwIfAborted or reason. */
export function mobileAbortError(): Error {
  const error = new Error('操作已取消')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal?: Pick<AbortSignal, 'aborted'>): void {
  if (signal?.aborted) throw mobileAbortError()
}
