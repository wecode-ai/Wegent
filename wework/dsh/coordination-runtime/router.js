/** Programmatic routing consumes Executor-authorized facts and grants no authority. */
export const SILENT_WINDOW_MS = 5 * 60 * 1000

function timestamp(value, label) {
  const result = Date.parse(value)
  if (!Number.isFinite(result)) throw new Error(`Invalid ${label}`)
  return result
}

function immediatelyEligible(event) {
  return (
    event.processingMode === 'immediate' ||
    Boolean(event.dispatch) ||
    ['human_command', 'schedule_due'].includes(event.kind) ||
    (event.kind === 'work_state' && event.requiresAction === true)
  )
}

/** A silent source has a fixed window from its first pending input, not a sliding debounce. */
function sourceWindows(events) {
  const windows = new Map()
  for (const event of events) {
    if (immediatelyEligible(event)) continue
    const received = timestamp(event.receivedAt, 'event receive time')
    windows.set(event.sourceKey, Math.min(windows.get(event.sourceKey) ?? Infinity, received))
  }
  return windows
}

export function planIntake(snapshot, { now = Date.now(), force = false } = {}) {
  if (!Number.isFinite(now)) throw new Error('Invalid routing time')
  if (!snapshot.context.enabled) return { actions: [], nextWakeAt: null }
  const events = snapshot.events
  const windows = sourceWindows(events)
  const actions = []
  const existing = new Map()
  const assess = []
  let nextWakeAt = Infinity
  for (const event of events) {
    const explicitDue = event.notBefore ? timestamp(event.notBefore, 'event due time') : -Infinity
    const windowDue =
      force || immediatelyEligible(event)
        ? -Infinity
        : windows.get(event.sourceKey) + SILENT_WINDOW_MS
    const due = Math.max(explicitDue, windowDue)
    if (due > now) {
      nextWakeAt = Math.min(nextWakeAt, due)
      continue
    }
    if (event.kind === 'schedule_due' && event.arrangement) {
      actions.push({ kind: 'dispatch_arrangement', eventIds: [event.id] })
      continue
    }
    if (event.dispatch) {
      actions.push({ kind: 'dispatch_work', roleId: event.dispatch.roleId, eventIds: [event.id] })
      continue
    }
    // Only the Executor can supply a verified binding. Text similarity is not ownership.
    const binding = event.binding
    if (!binding) {
      assess.push(event.id)
      continue
    }
    if (binding.awaitingUser || binding.awaitingApproval) {
      actions.push({ kind: 'wait_for_work', eventIds: [event.id], workId: binding.workId })
      continue
    }
    const key = JSON.stringify([binding.workId, binding.revision])
    const action = existing.get(key) ?? {
      kind: 'continue_work',
      workId: binding.workId,
      workRevision: binding.revision,
      eventIds: [],
    }
    action.eventIds.push(event.id)
    existing.set(key, action)
  }
  actions.push(...existing.values())
  if (assess.length) actions.push({ kind: 'assess', eventIds: assess })
  return {
    actions,
    nextWakeAt: Number.isFinite(nextWakeAt) ? new Date(nextWakeAt).toISOString() : null,
  }
}
