import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const REGION_METRICS = new Set([
  'mutationBatches',
  'mutationRecords',
  'attributeChanges',
  'textChanges',
  'addedNodes',
  'removedNodes',
  'rootRemovals',
  'addedSubtreeElements',
  'removedSubtreeElements',
  'maxAddedSubtreeElements',
  'maxRemovedSubtreeElements',
])

function assertMaximum(actual, maximum, description) {
  assert.ok(Number.isFinite(maximum) && maximum >= 0, `${description}: budget must be nonnegative`)
  assert.ok(
    typeof actual === 'number' && Number.isFinite(actual) && actual >= 0,
    `${description}: measurement is unavailable`
  )
  assert.ok(actual <= maximum, `${description}: observed ${actual}, budget ${maximum}`)
}

export function assertUiRefreshBudgets(snapshot, budgets) {
  assert.equal(snapshot.complete, true, 'UI refresh collection is incomplete')
  assert.equal(snapshot.actionSucceeded, true, 'The measured operation did not complete')
  assert.equal(snapshot.version, 1, 'Unsupported UI refresh measurement version')
  for (const key of Object.keys(budgets)) {
    assert.ok(
      ['regions', 'renders', 'reactCommits', 'responsiveness'].includes(key),
      `Unknown UI refresh budget: ${key}`
    )
  }
  let checked = 0
  for (const [name, limits] of Object.entries(budgets.regions ?? {})) {
    const region = snapshot.regions[name]
    assert.ok(region, `Unknown UI refresh region: ${name}`)
    assert.ok(
      region.observed === true || limits.allowAbsent === true,
      `UI refresh region was never observed: ${name}`
    )
    for (const [metric, maximum] of Object.entries(limits)) {
      if (metric === 'allowAbsent') continue
      assert.ok(REGION_METRICS.has(metric), `Unknown UI refresh metric: ${metric}`)
      assertMaximum(region[metric], maximum, `${name}.${metric}`)
      checked += 1
    }
  }
  for (const [id, maximum] of Object.entries(budgets.renders ?? {})) {
    assertMaximum(snapshot.renders[id], maximum, `${id}.renderCalls`)
    checked += 1
  }
  if (budgets.reactCommits !== undefined) {
    assertMaximum(snapshot.reactCommits?.count, budgets.reactCommits, 'React commit count')
    checked += 1
  }
  for (const [metric, maximum] of Object.entries(budgets.responsiveness ?? {})) {
    const type = ['longTaskCount', 'longTaskTotalMs', 'longTaskMaxMs'].includes(metric)
      ? 'longtask'
      : ['frameCount', 'frameTotalMs', 'frameMaxMs', 'slowScriptCount', 'slowScriptMaxMs'].includes(
            metric
          )
        ? 'long-animation-frame'
        : null
    assert.ok(type, `Unknown responsiveness metric: ${metric}`)
    assert.ok(
      Array.isArray(snapshot.responsiveness?.supportedEntryTypes) &&
        snapshot.responsiveness.supportedEntryTypes.includes(type),
      `Responsiveness measurement unavailable: ${type}`
    )
    assertMaximum(snapshot.responsiveness[metric], maximum, metric)
    checked++
  }
  assert.ok(checked > 0, 'At least one UI refresh budget is required')
}

function validateSnapshot(snapshot, token) {
  assert.equal(snapshot.version, 1)
  assert.equal(snapshot.captureId, token.captureId, 'UI refresh capture identity changed')
  assert.equal(snapshot.rendererInstanceId, token.rendererInstanceId, 'UI refresh renderer changed')
  assert.ok(
    snapshot.regions && typeof snapshot.regions === 'object' && !Array.isArray(snapshot.regions),
    'Missing UI region measurements'
  )
  assert.ok(
    snapshot.renders && typeof snapshot.renders === 'object' && !Array.isArray(snapshot.renders),
    'Missing UI render measurements'
  )
  assert.ok(
    snapshot.reactCommits === null ||
      (Number.isSafeInteger(snapshot.reactCommits?.count) &&
        snapshot.reactCommits.count >= 0 &&
        Number.isFinite(snapshot.reactCommits.actualDurationMs) &&
        snapshot.reactCommits.actualDurationMs >= 0),
    'Missing React commit measurement availability'
  )
  for (const name of token.regionNames) {
    const region = snapshot.regions?.[name]
    assert.equal(typeof region?.observed, 'boolean', `Missing UI refresh region: ${name}`)
    for (const metric of REGION_METRICS) {
      assert.ok(
        Number.isSafeInteger(region[metric]) && region[metric] >= 0,
        `Missing UI refresh counter: ${name}.${metric}`
      )
    }
  }
  for (const id of token.renderIds) {
    const count = snapshot.renders?.[id]
    assert.ok(
      count === null || (Number.isSafeInteger(count) && count >= 0),
      `Missing render counter: ${id}`
    )
  }
}

/** Operation windows include background activity; the label is not causal attribution. */
export class DesktopUiRefreshCollector {
  constructor(control, resultDir) {
    this.control = control
    this.path = join(resultDir, 'ui-refresh.jsonl')
  }

  async start(label, options = {}) {
    const clientId = this.control.activeControlClientId
    assert.ok(
      typeof clientId === 'string' && clientId.length > 0,
      'UI refresh capture requires an active renderer'
    )
    const token = JSON.parse(
      await this.control.commandForClient(clientId, 'startUiRefreshCapture', 'body', {
        value: JSON.stringify(options),
      })
    )
    assert.ok(
      typeof token.captureId === 'string' &&
        token.captureId.length > 0 &&
        typeof token.rendererInstanceId === 'string' &&
        token.rendererInstanceId.length > 0,
      'Missing UI refresh identity'
    )
    assert.ok(
      Array.isArray(token.regionNames) && Array.isArray(token.renderIds),
      'Missing UI refresh coverage declaration'
    )
    return { ...token, label, clientId }
  }

  persist(result) {
    appendFileSync(this.path, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async stop(token, actionSucceeded = true) {
    let snapshot
    try {
      snapshot = JSON.parse(
        await this.control.commandForClient(token.clientId, 'stopUiRefreshCapture', 'body', {
          value: JSON.stringify({
            captureId: token.captureId,
            rendererInstanceId: token.rendererInstanceId,
          }),
        })
      )
      validateSnapshot(snapshot, token)
    } catch (error) {
      try {
        this.persist({ ...token, complete: false, actionSucceeded })
      } catch (writeError) {
        throw new AggregateError(
          [error, writeError],
          'UI refresh collection and evidence persistence failed'
        )
      }
      throw error
    }
    const result = {
      ...snapshot,
      label: token.label,
      clientId: token.clientId,
      complete: true,
      actionSucceeded,
    }
    this.persist(result)
    return result
  }

  async measure(label, options, action) {
    const token = await this.start(label, options)
    try {
      await action()
    } catch (error) {
      try {
        await this.stop(token, false)
      } catch (captureError) {
        throw new AggregateError(
          [error, captureError],
          'Operation and UI refresh collection failed'
        )
      }
      throw error
    }
    return this.stop(token)
  }

  assertWithin(snapshot, budgets) {
    assertUiRefreshBudgets(snapshot, budgets)
  }
}
