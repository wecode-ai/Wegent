import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// The follow-up observes the failed condition itself instead of sampling after a
// fixed delay: the WebView bridge's waitFor polls the condition inside the
// renderer on its scheduling tick, so the capture happens the moment the
// condition settles (recording the measured convergence time) or when the
// overall budget expires (recording that the condition did not settle). A
// fixed delay could only ever sample one arbitrary time slice (#4293).
const DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS = 10_000
const FOLLOWUP_COMMAND_TIMEOUT_MS = 5_000

// Renderer actions that wait on a condition through waitForDesktopControlElement
// and therefore time out with the identical renderer message shape. Audited
// against every waitForDesktopControlElement call site: 'waitFor', the
// click/choose/select variants whose wait predicate the renderer enforces
// beyond the delivered options (automation.ts spreads them after the command),
// and 'getValueWhenReady', which waits with exactly the delivered options.
// The variants' side effects live in the on-match callback, not in the wait
// predicate, so re-observing them as a plain waitFor with the enforced
// predicate reproduces the failed condition exactly without replaying the
// side effect. endDrag's internal waitForSelector wait is deliberately not
// listed: its timeout message embeds waitForSelector instead of the recorded
// command's selector, so attribution declines it to a plain state capture.
const WAIT_LIKE_ACTIONS = new Set([
  'waitFor',
  'clickWhenEnabled',
  'chooseWhenEnabled',
  'setExpanded',
  'getValueWhenReady',
  'select',
])
// Wait predicates the renderer enforces per action, overriding any delivered
// option of the same name ({ ...command, enabled: true, … }).
const ENFORCED_WAIT_PREDICATES = {
  clickWhenEnabled: { enabled: true },
  chooseWhenEnabled: { enabled: true, visible: true },
  setExpanded: { enabled: true },
  select: { enabled: true },
}

/**
 * Resolve the overall observation budget. 0 disables the follow-up capture
 * entirely; values above the default still apply as a custom budget so the
 * worst case always equals the configured value.
 */
export function failureFollowupBudgetMs(rawValue = process.env.WEWORK_E2E_FAILURE_FOLLOWUP_MS) {
  if (rawValue === undefined || rawValue === '') return DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS
  const parsed = Number(rawValue)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FAILURE_FOLLOWUP_BUDGET_MS
}

function withDeadline(promise, deadlineAt, label) {
  let timeout
  const deadline = new Promise((resolvePromise, reject) => {
    const remaining = deadlineAt - Date.now()
    if (remaining <= 0) {
      reject(new Error(`The failure follow-up ${label} exceeded its overall deadline`))
      return
    }
    timeout = setTimeout(() => {
      reject(new Error(`The failure follow-up ${label} exceeded its overall deadline`))
    }, remaining)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout))
}

function followupOutcome(settledAt, failedAt, condition, snapshot, workbenchDebug) {
  if (!condition) {
    return {
      outcome: 'state-captured',
      condition: null,
      uiSnapshot: snapshot,
      workbenchDebug,
    }
  }
  if (settledAt === null) {
    return {
      outcome: 'condition-unsettled-within-budget',
      condition,
      uiSnapshot: snapshot,
      workbenchDebug,
    }
  }
  return {
    outcome: 'settled-after-failure',
    condition,
    settledAfterFailureMs: settledAt - failedAt,
    uiSnapshot: snapshot,
    workbenchDebug,
  }
}

/**
 * Recover the failed wait condition with its full options from the control
 * server's delivered-command history. The runner awaits commands serially, so
 * when the failure is a wait timeout, the last delivered wait-like command is
 * the failed one, and its history entry carries every option (selector, text,
 * visible, enabled, stableMs, target) plus the clientId of the window that ran
 * it — none of which survive in the timeout error message. Re-issuing without
 * them would observe a weaker condition, or the wrong window's DOM, and could
 * report a false settle (#4293 review).
 *
 * Attribution never parses the selector out of the message: the renderer
 * embeds selector, target, and text verbatim with unescaped internal quotes,
 * so any regex extraction is unreliable (scoped waits whose target carries
 * quoted attributes used to be mis-split). Instead the message is compared,
 * as an exact string, against what the recorded history entry would have
 * produced:
 *
 * - renderer shape (`Timed out waiting for selector "…"`): trusted only when
 *   the message starts with the recorded selector in quotes. Scenario-authored
 *   errors can mimic the prefix (local-terminal.scenario.mjs throws one for
 *   its hand-rolled getText poll) but carry a different selector; genuine
 *   timeouts for a command that is not the recorded wait-like one (endDrag's
 *   waitForSelector, or a hypothetical concurrent flow) also fail the
 *   comparison. Both decline observation instead of watching a wrong or
 *   weakened condition.
 * - server result timeout (`Timed out running UI action … for …`): the failed
 *   command was delivered and the renderer never answered; the message is
 *   reconstructible from the recorded entry, so require exact agreement.
 * - server delivery timeout (`Timed out delivering UI action …`): the command
 *   was removed from the server queue undelivered, so the history provably
 *   lacks it and any recorded wait-like entry would be stale — decline.
 * - every other error (click "is disabled", assertion failures, model-server
 *   errors) declines as well, even with a populated history.
 */
export function failedWaitCondition(error, commandHistory = []) {
  if (!(error instanceof Error)) return null
  const message = error.message
  const lastWait = [...commandHistory].reverse().find(entry => WAIT_LIKE_ACTIONS.has(entry?.action))
  if (message.startsWith('Timed out waiting for selector "')) {
    if (lastWait && message.startsWith(`Timed out waiting for selector "${lastWait.selector}"`)) {
      return conditionFromHistory(lastWait)
    }
    return null
  }
  const running = message.match(/^Timed out running UI action (\S+) for /)
  if (running && WAIT_LIKE_ACTIONS.has(running[1])) {
    const attributable =
      lastWait &&
      message === `Timed out running UI action ${lastWait.action} for ${lastWait.selector}`
    return attributable ? conditionFromHistory(lastWait) : null
  }
  return null
}

function conditionFromHistory(entry) {
  const condition = { selector: entry.selector, action: entry.action }
  for (const key of ['text', 'visible', 'enabled', 'stableMs', 'target', 'clientId']) {
    if (entry[key] !== undefined) condition[key] = entry[key]
  }
  // Mirror the predicate the renderer actually applied: enforced options
  // override delivered ones of the same name, exactly as the renderer's
  // { ...command, enabled: true, … } spread does.
  Object.assign(condition, ENFORCED_WAIT_PREDICATES[entry.action])
  return condition
}

/**
 * Observe the failed wait condition after a checkpoint step has already failed.
 * The follow-up never weakens the original assertion: it re-issues the same
 * wait predicate as a plain waitFor (condition poll, bounded by the observation
 * window) and records either the measured convergence time or that the
 * condition did not settle within the budget, then captures the UI snapshot and
 * workbench debug state.
 *
 * Observation and evidence capture are routed to the control client that ran
 * the failed command when the condition carries one: checkpoints can drive a
 * detached window through commandForWindow while the active client remains the
 * main window, and both windows show the same session — observing the wrong
 * one fabricates convergence in both directions. A condition whose client has
 * since disconnected (its window closed, so the failed DOM no longer exists)
 * degrades to a plain state capture of the active window.
 *
 * Anchors are deliberately separate: `failedAt` anchors the measurement
 * (`settledAfterFailureMs` is true wall time since the step failure), while
 * the budget bounds only the wall clock this follow-up itself adds, counted
 * from its own start. Anchoring the budget at `failedAt` instead would let
 * the pre-follow-up diagnostics capture (6 commands, up to 30s delivery
 * timeouts each on a severed channel) silently starve the observation window
 * to zero. The capture reserve keeps an unsettled observation able to write
 * its evidence, but never exceeds half the budget so small budgets still
 * observe meaningfully; `observationBudgetMs` and `observedForMs` make the
 * window and its actual use explicit in the evidence.
 */
export async function captureFailureFollowup(
  control,
  resultDir,
  { condition, failedAt = Date.now(), budgetMs = failureFollowupBudgetMs() } = {}
) {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return null
  const startedAt = Date.now()
  const captureWindowMs = Math.min(FOLLOWUP_COMMAND_TIMEOUT_MS + 500, Math.floor(budgetMs / 2))
  const observationBudgetMs = Math.max(1, budgetMs - captureWindowMs)
  const observeDeadlineAt = startedAt + observationBudgetMs
  const deadlineAt = startedAt + budgetMs
  const clientId = condition?.clientId
  const clientAvailable =
    clientId === undefined || Boolean(control.controlWindowsByClient?.has(clientId))
  const routedCondition = clientAvailable ? condition : null
  const sendCommand = (action, selector, options) =>
    clientId !== undefined && clientAvailable && typeof control.commandForClient === 'function'
      ? control.commandForClient(clientId, action, selector, options)
      : control.command(action, selector, options)
  const observationStartedAt = Date.now()
  let settledAt = null
  if (routedCondition) {
    try {
      await withDeadline(
        sendCommand('waitFor', routedCondition.selector, {
          ...('text' in routedCondition ? { text: routedCondition.text } : {}),
          ...('visible' in routedCondition ? { visible: routedCondition.visible } : {}),
          ...('enabled' in routedCondition ? { enabled: routedCondition.enabled } : {}),
          ...('stableMs' in routedCondition ? { stableMs: routedCondition.stableMs } : {}),
          ...('target' in routedCondition ? { target: routedCondition.target } : {}),
          timeoutMs: Math.max(1, observeDeadlineAt - Date.now()),
        }),
        observeDeadlineAt,
        'observation wait'
      )
      settledAt = Date.now()
    } catch {
      // The condition never settled within the budget; that is the recorded
      // outcome, not an error.
    }
  }
  const observedForMs = Date.now() - observationStartedAt
  const [snapshot, workbenchDebug] = await withDeadline(
    Promise.all([
      sendCommand('snapshot', 'body', { timeoutMs: FOLLOWUP_COMMAND_TIMEOUT_MS }),
      sendCommand('getWorkbenchDebugSnapshot', 'body', {
        timeoutMs: FOLLOWUP_COMMAND_TIMEOUT_MS,
      }),
    ]),
    deadlineAt,
    'capture'
  )
  const followup = {
    capturedAt: new Date().toISOString(),
    failedAt: new Date(failedAt).toISOString(),
    budgetMs,
    observationBudgetMs,
    observedForMs,
    ...followupOutcome(
      settledAt,
      failedAt,
      routedCondition ?? null,
      JSON.parse(snapshot),
      JSON.parse(workbenchDebug)
    ),
  }
  await writeFile(
    join(resultDir, 'failure-followup.json'),
    `${JSON.stringify(followup, null, 2)}\n`,
    'utf8'
  )
  return followup
}
