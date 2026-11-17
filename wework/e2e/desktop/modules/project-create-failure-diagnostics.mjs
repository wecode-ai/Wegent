const CREATE_CONFIRM = '[data-testid="collaboration-project-create-confirm"]'
const PROJECT_HEADER = '[data-testid="cloud-project-header-title"]'
const PAGE_MARKERS = [
  'collaboration-platform-root',
  'collaboration-platform-opening-project',
  'collaboration-project-create-dialog',
  'collaboration-project-create-confirm',
  'project-create-template-section',
  'collaboration-template-dialog',
  'cloud-project-header-title',
  'collaboration-error',
  'collaboration-empty-project',
]

function commandStage(command) {
  if (!command) return null
  const elapsed = (start, end) => {
    const value = Date.parse(end) - Date.parse(start)
    return Number.isFinite(value) && value >= 0 ? value : null
  }
  return {
    delivered: Boolean(command.deliveredAt),
    started: Boolean(command.startedAt),
    resultReceived: Boolean(command.resultReceivedAt),
    failed: Boolean(command.failedAt),
    queueMs: elapsed(command.queuedAt, command.deliveredAt),
    executionMs: elapsed(command.startedAt, command.resultReceivedAt),
  }
}

/** Reuse captured evidence without publishing page text, URLs, or arbitrary attributes. */
export function projectCreationHeaderFailureSummary(followup, commandHistory = []) {
  const condition = followup?.condition
  if (condition?.action !== 'waitFor' || !condition.selector?.endsWith(PROJECT_HEADER)) return null
  const history = commandHistory.filter(command => command.clientId === condition.clientId)
  const submitIndex = history.findLastIndex(
    command => command.action === 'clickWhenEnabled' && command.selector?.endsWith(CREATE_CONFIRM)
  )
  if (submitIndex < 0) return null
  const creationHistory = history.slice(submitIndex)
  const hiddenIndex = creationHistory.findIndex(
    command =>
      command.action === 'waitFor' &&
      command.selector?.endsWith(CREATE_CONFIRM) &&
      command.visible === false
  )
  const hidden = creationHistory[hiddenIndex]
  const header = creationHistory[hiddenIndex + 1]
  if (hiddenIndex < 0 || header?.action !== 'waitFor' || header.selector !== condition.selector)
    return null
  const mounted = new Set(followup.uiSnapshot?.testIds ?? [])
  const workbench = followup.workbenchDebug?.workbench
  return {
    event: 'project-create-header-failure',
    conditionSettledAfterFailure: followup.outcome === 'settled-after-failure',
    stages: {
      submit: commandStage(history[submitIndex]),
      formHidden: commandStage(hidden),
      header: commandStage(header),
    },
    mountedPageMarkers: Object.fromEntries(PAGE_MARKERS.map(id => [id, mounted.has(id)])),
    workbench: {
      captured: Boolean(workbench),
      bootstrapping: workbench?.isBootstrapping === true,
      hasError: Boolean(workbench?.error),
    },
  }
}
