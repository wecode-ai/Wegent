export type IssueActivityRow<T> =
  | { kind: 'activity'; activity: T }
  | { kind: 'collapsed'; count: number; firstSequence?: number; lastSequence?: number }

/** Keep both ends of a long discussion without mounting its hidden middle. */
export function collapsedIssueActivity<T>(
  activities: readonly T[],
  expanded: boolean,
  sequences?: (activity: T) => readonly number[]
): IssueActivityRow<T>[] {
  const row = (activity: T): IssueActivityRow<T> => ({ kind: 'activity', activity })
  if (expanded || activities.length <= 20) return activities.map(row)
  let firstSequence = Infinity
  let lastSequence = 0
  if (sequences) {
    for (let index = 2; index < activities.length - 10; index++) {
      for (const sequence of sequences(activities[index])) {
        if (Number.isFinite(sequence) && sequence > 0) {
          firstSequence = Math.min(firstSequence, sequence)
          lastSequence = Math.max(lastSequence, sequence)
        }
      }
    }
  }
  return [
    ...activities.slice(0, 2).map(row),
    {
      kind: 'collapsed',
      count: activities.length - 12,
      ...(lastSequence > 0 ? { firstSequence, lastSequence } : {}),
    },
    ...activities.slice(-10).map(row),
  ]
}
