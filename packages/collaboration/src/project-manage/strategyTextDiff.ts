// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

export interface StrategyDiffLine {
  kind: 'unchanged' | 'removed' | 'added'
  text: string
}

export function strategyTextDiff(previous: string, current: string): StrategyDiffLine[] {
  const before = previous.split('\n')
  const after = current.split('\n')
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let beforeEnd = before.length
  let afterEnd = after.length
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--
    afterEnd--
  }
  return [
    ...before.slice(0, start).map(text => ({ kind: 'unchanged' as const, text })),
    ...before.slice(start, beforeEnd).map(text => ({ kind: 'removed' as const, text })),
    ...after.slice(start, afterEnd).map(text => ({ kind: 'added' as const, text })),
    ...after.slice(afterEnd).map(text => ({ kind: 'unchanged' as const, text })),
  ]
}
