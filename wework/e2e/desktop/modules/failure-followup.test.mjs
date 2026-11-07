import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  captureFailureFollowup,
  failedWaitCondition,
  failureFollowupBudgetMs,
} from './failure-followup.mjs'

function controlReturning({
  waitForBehavior = 'settle-after',
  uiSnapshot,
  workbenchDebug,
  registeredClients,
} = {}) {
  const commands = []
  const handle = async (via, clientId, action, selector, options) => {
    commands.push({ via, clientId, action, selector, options })
    if (action === 'waitFor') {
      if (waitForBehavior === 'settle-after') {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
        return ''
      }
      if (waitForBehavior === 'never-settle') {
        await new Promise((resolvePromise, reject) => {
          const timer = setTimeout(() => {
            clearTimeout(timer)
            reject(new Error('Timed out waiting for selector (test)'))
          }, options?.timeoutMs ?? 10_000)
        })
        throw new Error('unreachable')
      }
      if (waitForBehavior === 'hang') return new Promise(() => {})
    }
    if (action === 'snapshot') return JSON.stringify(uiSnapshot ?? { testIds: [] })
    if (action === 'getWorkbenchDebugSnapshot') {
      return JSON.stringify(workbenchDebug ?? { workbench: {} })
    }
    throw new Error(`Unexpected control command: ${action}`)
  }
  const control = {
    commands,
    command: (action, selector, options) => handle('active', undefined, action, selector, options),
  }
  if (registeredClients !== undefined) {
    control.controlWindowsByClient = new Map(
      registeredClients.map(clientId => [clientId, `window-${clientId}`])
    )
    control.commandForClient = (clientId, action, selector, options) =>
      handle('client', clientId, action, selector, options)
  }
  return control
}

test('resolves the observation budget from the environment with a safe default', () => {
  assert.equal(failureFollowupBudgetMs(undefined), 10_000)
  assert.equal(failureFollowupBudgetMs(''), 10_000)
  assert.equal(failureFollowupBudgetMs('0'), 0)
  assert.equal(failureFollowupBudgetMs('25000'), 25_000)
  assert.equal(failureFollowupBudgetMs('not-a-number'), 10_000)
  assert.equal(failureFollowupBudgetMs('-5'), 10_000)
  // Non-finite values must not produce an unbounded budget (the guard #4420
  // added for the old fixed delay; the redesign keeps it for the budget).
  assert.equal(failureFollowupBudgetMs('Infinity'), 10_000)
})

test('recovers the failed wait condition with full options from the command history', () => {
  const history = [
    { action: 'click', selector: '[data-testid="a"]' },
    {
      action: 'waitFor',
      selector: '[data-testid="title"]',
      text: 'expected',
      visible: true,
      enabled: true,
      stableMs: 500,
      target: '[data-testid="panel"]',
      timeoutMs: 10_000,
    },
  ]
  const condition = failedWaitCondition(
    new Error('Timed out waiting for selector "[data-testid="title"]"; matches=[]'),
    history
  )
  assert.deepEqual(condition, {
    selector: '[data-testid="title"]',
    action: 'waitFor',
    text: 'expected',
    visible: true,
    enabled: true,
    stableMs: 500,
    target: '[data-testid="panel"]',
  })
  // timeoutMs is deliberately not forwarded: the observation has its own budget.
  assert.equal('timeoutMs' in condition, false)
  // The server-side result timeout shape also gates recovery, attributed by
  // exact reconstruction of the server message from the recorded entry.
  assert.deepEqual(
    failedWaitCondition(new Error('Timed out running UI action waitFor for [data-testid="x"]'), [
      { action: 'waitFor', selector: '[data-testid="x"]' },
    ]),
    { selector: '[data-testid="x"]', action: 'waitFor' }
  )
  // A running timeout that does not match the recorded entry declines rather
  // than observing whatever wait-like command happens to be last.
  assert.equal(
    failedWaitCondition(new Error('Timed out running UI action waitFor for [data-testid="x"]'), [
      { action: 'waitFor', selector: '[data-testid="other"]' },
    ]),
    null
  )
  assert.equal(
    failedWaitCondition(new Error('Timed out running UI action click for [data-testid="x"]'), [
      { action: 'waitFor', selector: '[data-testid="x"]' },
    ]),
    null
  )
})

test('recovers scoped waits whose target selector contains quoted attributes', () => {
  // Real shapes from local-file-preview.scenario.mjs: the renderer embeds the
  // target verbatim with unescaped quotes, which defeated any regex parsing of
  // the selector. Attribution by prefix comparison against the recorded
  // selector is immune, and the recovered condition keeps the target.
  const selector = 'button[data-type="item"][aria-label="first.ts"]'
  const target = '[data-testid="workspace-file-directory-menu"]'
  const history = [{ action: 'waitFor', selector, target, timeoutMs: 10_000 }]
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${selector}" within "${target}"; matches=[]`),
      history
    ),
    { selector, action: 'waitFor', target }
  )
})

test('recovers the enabled predicate of wait-like click actions without replaying them', () => {
  // clickWhenEnabled and setExpanded route through the same renderer wait with
  // an enforced enabled predicate (automation.ts); their timeouts are
  // byte-identical to waitFor timeouts. Recovery must restore enabled:true so
  // the observation does not over-settle on a still-disabled control.
  const pickerSelector = '[data-testid="confirm-device-folder-picker-button"]'
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${pickerSelector}"; matches=[]`),
      [{ action: 'clickWhenEnabled', selector: pickerSelector, timeoutMs: 10_000 }]
    ),
    { selector: pickerSelector, action: 'clickWhenEnabled', enabled: true }
  )
  const disclosureSelector = '[data-testid="conversation-history-disclosure"]'
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${disclosureSelector}"; matches=[]`),
      [{ action: 'setExpanded', selector: disclosureSelector, value: 'true' }]
    ),
    { selector: disclosureSelector, action: 'setExpanded', enabled: true }
  )
  // The server result timeout for a click-like wait is attributed the same way.
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out running UI action clickWhenEnabled for ${pickerSelector}`),
      [{ action: 'clickWhenEnabled', selector: pickerSelector }]
    ),
    { selector: pickerSelector, action: 'clickWhenEnabled', enabled: true }
  )
  // The renderer enforces enabled:true for click-like waits even when the
  // delivered command carried another value, so recovery mirrors the
  // effective predicate rather than the recorded option.
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${pickerSelector}"; matches=[]`),
      [{ action: 'clickWhenEnabled', selector: pickerSelector, enabled: false }]
    ),
    { selector: pickerSelector, action: 'clickWhenEnabled', enabled: true }
  )
  // chooseWhenEnabled enforces enabled AND visible (automation.ts), overriding
  // delivered options; its select side effect must not be replayed either.
  const tabSelector = '[data-testid="workspace-tab-select-fixed-task"]'
  assert.deepEqual(
    failedWaitCondition(new Error(`Timed out waiting for selector "${tabSelector}"; matches=[]`), [
      { action: 'chooseWhenEnabled', selector: tabSelector, value: 'x', visible: false },
    ]),
    { selector: tabSelector, action: 'chooseWhenEnabled', enabled: true, visible: true }
  )
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out running UI action chooseWhenEnabled for ${tabSelector}`),
      [{ action: 'chooseWhenEnabled', selector: tabSelector }]
    ),
    { selector: tabSelector, action: 'chooseWhenEnabled', enabled: true, visible: true }
  )
  // getValueWhenReady waits with exactly the delivered options (no enforced
  // predicate) and its on-match callback is a pure read.
  const valueSelector = '[data-testid="stand-in-notification-badge"]'
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${valueSelector}" containing "3"; matches=[]`),
      [{ action: 'getValueWhenReady', selector: valueSelector, text: '3', visible: true }]
    ),
    { selector: valueSelector, action: 'getValueWhenReady', text: '3', visible: true }
  )
  // select became wait-like when the renderer refactor (#4417) routed it
  // through waitForDesktopControlElement with an enforced enabled predicate;
  // its option-choosing side effect must not be replayed either.
  const statusSelector = '[data-testid="project-task-status-select"]'
  assert.deepEqual(
    failedWaitCondition(
      new Error(`Timed out waiting for selector "${statusSelector}"; matches=[]`),
      [{ action: 'select', selector: statusSelector, value: 'Done' }]
    ),
    { selector: statusSelector, action: 'select', enabled: true }
  )
})

test('declines observation when the history cannot account for the failed wait', () => {
  // A genuine renderer timeout implies the command was delivered and therefore
  // recorded; with no wait-like entry there is nothing to attribute the
  // failure to, and parsing the selector out of the message is unreliable
  // (unescaped internal quotes), so observation declines to state capture.
  assert.equal(
    failedWaitCondition(
      new Error(
        'Timed out waiting for selector "[data-workspace-tab-content][aria-hidden="false"] [data-testid="cloud-project-header-title"]" containing "模板新项目-3245"; matches=[]'
      ),
      []
    ),
    null
  )
  // endDrag's waitForSelector timeout embeds a selector that is not the
  // recorded command's own selector; it must not adopt the stale entry.
  assert.equal(
    failedWaitCondition(
      new Error('Timed out waiting for selector "[data-testid="drop-result"]"; matches=[]'),
      [
        {
          action: 'endDrag',
          selector: '[data-testid="drag-source"]',
          waitForSelector: '[data-testid="drop-result"]',
        },
      ]
    ),
    null
  )
})

test('returns null for scenario-authored renderer-shape mimics even with populated history', () => {
  // Real message from local-terminal.scenario.mjs: a hand-rolled getText poll
  // that throws a renderer-shaped error for a selector that was never a
  // control command. Attribution compares against the recorded entry's
  // selector, so the stale history waitFor must not be adopted.
  const mimic = new Error(
    'Timed out waiting for selector "[data-testid="harness-settings-kimi_code"]" containing version "1.0.0" or path "/opt/kimi-code"'
  )
  const history = [
    { action: 'waitFor', selector: '[data-testid="settings-panel"]', visible: true },
    { action: 'getText', selector: '[data-testid="harness-executable-path-kimi_code"]' },
  ]
  assert.equal(failedWaitCondition(mimic, history), null)
})

test('returns null for the delivering shape, whose command never entered the history', () => {
  // The server removes the command from the queue when delivery times out, so
  // the history provably lacks the failed waitFor; the last entry is stale.
  assert.equal(
    failedWaitCondition(
      new Error('Timed out delivering UI action waitFor for [data-testid="new-element"]'),
      [{ action: 'waitFor', selector: '[data-testid="old-settled"]' }]
    ),
    null
  )
})

test('declines observation when the history selector disagrees with the message', () => {
  // A genuine renderer timeout whose embedded selector is not the recorded
  // wait-like command's selector cannot be attributed (concurrent flows, or a
  // wait-like action whose message embeds another selector); declining beats
  // observing a condition that is not the failed one.
  const history = [{ action: 'waitFor', selector: '[data-testid="other-step"]', visible: true }]
  assert.equal(
    failedWaitCondition(
      new Error(
        'Timed out waiting for selector "[data-testid="header-title"]" containing "expected"; matches=[]'
      ),
      history
    ),
    null
  )
})

test('returns null for non-wait failures even with a populated history', () => {
  const history = [
    { action: 'waitFor', selector: '[data-testid="sidebar"]', visible: true },
    { action: 'click', selector: '[data-testid="send-button"]' },
  ]
  // A click "is disabled" failure must not recover the earlier, already-settled
  // sidebar wait as its condition.
  assert.equal(
    failedWaitCondition(new Error('Selector "[data-testid="send-button"]" is disabled'), history),
    null
  )
  assert.equal(
    failedWaitCondition(new Error('assert.equal failed: expected 3 got 2'), history),
    null
  )
  assert.equal(failedWaitCondition(new Error('Selector "x" is disabled'), []), null)
  assert.equal(failedWaitCondition(new Error('Something else entirely'), []), null)
  assert.equal(failedWaitCondition('not an error', []), null)
  assert.equal(failedWaitCondition(null, []), null)
})

test('re-issues the observed wait with every recovered option', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = controlReturning({ waitForBehavior: 'settle-after' })
    await captureFailureFollowup(control, resultDir, {
      condition: {
        selector: '[data-testid="title"]',
        action: 'waitFor',
        text: 'expected',
        visible: true,
        enabled: true,
        stableMs: 250,
        target: '[data-testid="panel"]',
      },
      failedAt: Date.now(),
      budgetMs: 10_000,
    })
    const waitCommand = control.commands[0]
    assert.equal(waitCommand.action, 'waitFor')
    assert.equal(waitCommand.selector, '[data-testid="title"]')
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(waitCommand.options).filter(([key]) => key !== 'timeoutMs')
      ),
      {
        text: 'expected',
        visible: true,
        enabled: true,
        stableMs: 250,
        target: '[data-testid="panel"]',
      }
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('routes the observation and capture to the failed condition control client', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    // Detached-window checkpoints drive a second window through
    // commandForWindow while the active client stays the main window; both
    // windows show the same session, so observing the active client would
    // fabricate evidence in both directions.
    const control = controlReturning({ waitForBehavior: 'settle-after', registeredClients: ['c2'] })
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: {
        selector: '[data-testid="pending-question"]',
        action: 'waitFor',
        clientId: 'c2',
      },
      failedAt: Date.now(),
      budgetMs: 10_000,
    })
    assert.equal(followup.outcome, 'settled-after-failure')
    assert.deepEqual(
      control.commands.map(command => [command.via, command.clientId, command.action]),
      [
        ['client', 'c2', 'waitFor'],
        ['client', 'c2', 'snapshot'],
        ['client', 'c2', 'getWorkbenchDebugSnapshot'],
      ]
    )
    // clientId and action are metadata, not wait options.
    assert.equal('clientId' in control.commands[0].options, false)
    assert.equal('action' in control.commands[0].options, false)
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a disconnected failed-window client degrades to an active-window state capture', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    // The window closed after the failure: its DOM is gone, so there is no
    // condition left to observe. Capture the active window's state instead of
    // failing every command against an unregistered client.
    const control = controlReturning({ waitForBehavior: 'settle-after', registeredClients: [] })
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: {
        selector: '[data-testid="pending-question"]',
        action: 'waitFor',
        clientId: 'c2',
      },
      failedAt: Date.now(),
      budgetMs: 10_000,
    })
    assert.equal(followup.outcome, 'state-captured')
    assert.equal(followup.condition, null)
    assert.deepEqual(
      control.commands.map(command => [command.via, command.action]),
      [
        ['active', 'snapshot'],
        ['active', 'getWorkbenchDebugSnapshot'],
      ]
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('small budgets keep a meaningful observation window and record it', async t => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  try {
    // The capture reserve never exceeds half the budget: a 3s budget must
    // still observe for its full 1.5s window rather than the 1ms floor the
    // fixed 5.5s reserve produced.
    const control = controlReturning({ waitForBehavior: 'never-settle' })
    const pending = captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="missing"]' },
      failedAt: Date.now(),
      budgetMs: 3_000,
    })
    await new Promise(setImmediate)
    t.mock.timers.tick(1_500)
    const followup = await pending
    assert.equal(followup.observationBudgetMs, 1_500)
    assert.equal(followup.outcome, 'condition-unsettled-within-budget')
    assert.equal(followup.observedForMs, 1_500)
    const stored = JSON.parse(await readFile(join(resultDir, 'failure-followup.json'), 'utf8'))
    assert.equal(stored.observationBudgetMs, 1_500)
    assert.equal(stored.observedForMs, 1_500)
  } finally {
    t.mock.timers.reset()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('records the measured convergence time when the failed condition settles', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = controlReturning({ waitForBehavior: 'settle-after' })
    const failedAt = Date.now()
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="header-title"]', text: 'expected' },
      failedAt,
      budgetMs: 10_000,
    })
    assert.equal(followup.outcome, 'settled-after-failure')
    assert.equal(followup.condition.selector, '[data-testid="header-title"]')
    assert.equal(followup.condition.text, 'expected')
    assert.ok(
      followup.settledAfterFailureMs >= 15 && followup.settledAfterFailureMs < 5_000,
      `convergence time should be measured, got ${followup.settledAfterFailureMs}`
    )
    assert.deepEqual(
      control.commands.map(command => command.action),
      ['waitFor', 'snapshot', 'getWorkbenchDebugSnapshot']
    )
    const stored = JSON.parse(await readFile(join(resultDir, 'failure-followup.json'), 'utf8'))
    assert.equal(stored.outcome, 'settled-after-failure')
    assert.equal(stored.budgetMs, 10_000)
    assert.ok(stored.failedAt)
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('records condition-unsettled-within-budget when the condition never settles', async t => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  // Controlled clock: the small capture reserve must not depend on real timer
  // punctuality (CodeRabbit review) — every millisecond here is ticked.
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  try {
    const control = controlReturning({ waitForBehavior: 'never-settle' })
    const pending = captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="missing"]' },
      failedAt: Date.now(),
      budgetMs: 50,
    })
    await new Promise(setImmediate)
    // Observation window: 50 - min(5500, floor(50 / 2)) = 25ms.
    t.mock.timers.tick(25)
    const followup = await pending
    assert.equal(followup.outcome, 'condition-unsettled-within-budget')
    assert.equal(followup.observationBudgetMs, 25)
    assert.equal(followup.observedForMs, 25)
    assert.equal(followup.settledAfterFailureMs, undefined)
    assert.equal(followup.condition.selector, '[data-testid="missing"]')
  } finally {
    t.mock.timers.reset()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a zero budget disables the follow-up without issuing any command', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = controlReturning()
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="x"]' },
      failedAt: Date.now(),
      budgetMs: 0,
    })
    assert.equal(followup, null)
    assert.deepEqual(control.commands, [])
    assert.equal(
      await readFile(join(resultDir, 'failure-followup.json'), 'utf8').catch(() => null),
      null
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('an immediately throwing control rejects so callers keep the original error separate', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = {
      command: async () => {
        throw new Error('The WebView can no longer answer diagnostics')
      },
    }
    await assert.rejects(
      captureFailureFollowup(control, resultDir, {
        condition: { selector: '[data-testid="x"]' },
        failedAt: Date.now(),
        budgetMs: 10_000,
      }),
      /no longer answer/
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a hanging wait command does not prevent the state capture from finishing', async t => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  try {
    const control = controlReturning({ waitForBehavior: 'hang' })
    const pending = captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="x"]' },
      failedAt: Date.now(),
      budgetMs: 100,
    })
    await new Promise(setImmediate)
    // The observation wait hangs until its 50ms window expires, then the
    // follow-up still captures the snapshot and records the unsettled outcome.
    t.mock.timers.tick(50)
    const followup = await pending
    assert.equal(followup.outcome, 'condition-unsettled-within-budget')
    assert.equal(followup.observedForMs, 50)
    assert.deepEqual(
      control.commands.map(command => command.action),
      ['waitFor', 'snapshot', 'getWorkbenchDebugSnapshot']
    )
  } finally {
    t.mock.timers.reset()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('a hanging state capture is still bounded by the overall budget', async t => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_700_000_000_000 })
  try {
    const control = {
      command: async action => {
        if (action === 'waitFor') return ''
        return new Promise(() => {})
      },
    }
    const pending = captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="x"]' },
      failedAt: Date.now(),
      budgetMs: 100,
    })
    // Let the instant observation settle and the capture arm its deadline
    // timer, then fire it deterministically.
    await new Promise(setImmediate)
    t.mock.timers.tick(100)
    await assert.rejects(pending, /exceeded its overall deadline/)
  } finally {
    t.mock.timers.reset()
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('the budget counts from the follow-up start, not from the failure', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    // Simulate the diagnostics capture consuming 8s before the follow-up
    // starts: with a 10s budget anchored at the failure, the observation
    // window would already be expired at entry.
    const failedAt = Date.now() - 8_000
    const control = controlReturning({ waitForBehavior: 'settle-after' })
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: { selector: '[data-testid="title"]' },
      failedAt,
      budgetMs: 10_000,
    })
    assert.equal(followup.outcome, 'settled-after-failure')
    assert.ok(
      followup.settledAfterFailureMs >= 8_000,
      `convergence time must be measured from the failure, got ${followup.settledAfterFailureMs}`
    )
    assert.ok(
      followup.observedForMs < 5_000,
      `observation must still have a full window, observed ${followup.observedForMs}ms`
    )
    assert.equal(followup.observationBudgetMs, 5_000)
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})

test('captures plain state without a condition when the failure is not a wait timeout', async () => {
  const resultDir = await mkdtemp(join(tmpdir(), 'wework-failure-followup-'))
  try {
    const control = controlReturning({
      uiSnapshot: { testIds: ['a-control'] },
      workbenchDebug: { workbench: { isBootstrapping: false } },
    })
    const followup = await captureFailureFollowup(control, resultDir, {
      condition: null,
      failedAt: Date.now(),
      budgetMs: 10_000,
    })
    assert.equal(followup.outcome, 'state-captured')
    assert.equal(followup.condition, null)
    assert.equal(followup.uiSnapshot.testIds[0], 'a-control')
    assert.equal(followup.workbenchDebug.workbench.isBootstrapping, false)
    assert.deepEqual(
      control.commands.map(command => command.action),
      ['snapshot', 'getWorkbenchDebugSnapshot']
    )
  } finally {
    await rm(resultDir, { recursive: true, force: true })
  }
})
