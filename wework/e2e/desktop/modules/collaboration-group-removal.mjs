import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

export async function waitForCollaborationGroupRemoval(
  control,
  contentSelector,
  groupId,
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS
) {
  // Persistence can finish before the owner refresh and modal cleanup.
  const removedGroup = `[data-testid="collaboration-group-${groupId}"]`
  const confirmation = '[data-testid="collaboration-group-delete-dialog"]'
  await control.command(
    'waitFor',
    `${contentSelector}:not(:has(${removedGroup})):not(:has(${confirmation}))`,
    { enabled: true, timeoutMs }
  )
}
