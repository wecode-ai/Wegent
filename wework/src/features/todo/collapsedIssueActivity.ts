export type IssueActivityRow<T> =
  | { kind: 'activity'; activity: T }
  | { kind: 'collapsed'; count: number }

/** Keep both ends of a long discussion without mounting its hidden middle. */
export function collapsedIssueActivity<T>(
  activities: readonly T[],
  expanded: boolean
): IssueActivityRow<T>[] {
  const row = (activity: T): IssueActivityRow<T> => ({ kind: 'activity', activity })
  if (expanded || activities.length <= 20) return activities.map(row)
  return [
    ...activities.slice(0, 2).map(row),
    { kind: 'collapsed', count: activities.length - 12 },
    ...activities.slice(-10).map(row),
  ]
}
