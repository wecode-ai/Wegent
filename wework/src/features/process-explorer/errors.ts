import type { ProcessDegradation } from '@wegent/process-explorer'

export function describeDegradation(
  degradation: ProcessDegradation,
  t: (key: string) => string
): string {
  const key = `process_explorer.degraded_reason.${degradation.code.replaceAll('-', '_')}`
  const translated = t(key)
  return translated === key ? (degradation.detail ?? degradation.code) : translated
}
