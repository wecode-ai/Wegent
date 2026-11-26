export type ForegroundAction = 'begin' | 'end' | null

export function foregroundTransition(
  foregroundOpen: boolean,
  next: string
): { foregroundOpen: boolean; action: ForegroundAction } {
  if (next === 'background' && foregroundOpen) return { foregroundOpen: false, action: 'end' }
  if (next === 'active' && !foregroundOpen) return { foregroundOpen: true, action: 'begin' }
  return { foregroundOpen, action: null }
}
