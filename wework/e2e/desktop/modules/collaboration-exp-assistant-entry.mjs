import assert from 'node:assert/strict'
import { mkdir, rename, rmdir } from 'node:fs/promises'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { runtimeTransportGates } from './runtime-transport-gates.mjs'

const workspace = '[data-testid="personal-stand-in-workspace"]'
const accountSetup = '[data-testid="personal-assistant-account-setup"]'
const experience = '[data-testid="stand-in-experience"]'
const legacy = '[data-testid="stand-in-overview"]'
const input = `${experience} [data-testid="collaboration-exp-assistant-input"]`
const dashboard = '[data-testid="stand-in-dashboard-open"]'
const startup = '[data-testid="workbench-startup"]'
const loading = '[data-testid="stand-in-preference-loading"]'
const retry = '[data-testid="stand-in-preference-retry"]'

async function evaluate(expression) {
  return withProjectRenderer(async (client, target) => {
    const response = await client({
      action: 'command',
      target,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true },
    })
    assert.equal(
      response.exceptionDetails,
      undefined,
      'Could not read the assistant entry diagnostics'
    )
    return response.result?.value
  })
}

const getAssistantMarks = () =>
  evaluate(`performance.getEntriesByType('mark').map(entry => entry.name)
    .filter(name => name.startsWith('wework:assistant-'))`)

export async function verifyAssistantPreferenceGate(control, preferencesFile) {
  const gates = runtimeTransportGates(control)
  const original = `${preferencesFile}.assistant-e2e-original`
  const preferencesRead = {
    id: 'assistant-preferences-read',
    kind: 'request',
    name: 'preferences.get',
    where: [{ path: 'params.requireReadable', equals: true }],
    holdFollowing: true,
  }
  const bindingRead = 'assistant-binding-before-preferences'
  const preferenceEvent = 'assistant-preference-change-during-read'
  const retain = [bindingRead, preferenceEvent]
  let moved = false
  let blocked = false
  const assertGateClosed = async selector => {
    await control.command('waitFor', selector, { visible: true })
    for (const page of [workspace, accountSetup, experience, legacy])
      assert.equal(await control.command('getElementCount', page), '0', `${page} mounted early`)
    assert.deepEqual(await getAssistantMarks(), [])
    assert.equal(
      await gates.read(bindingRead),
      null,
      'Binding discovery ran before preferences loaded'
    )
  }
  try {
    await gates.arm({ ...preferencesRead, afterReload: true })
    // A startup theme write can also publish a confirmed preference snapshot.
    await gates.arm({
      id: preferenceEvent,
      kind: 'event',
      name: 'wework:app-preferences-changed',
      holdFollowing: true,
      afterReload: true,
    })
    await gates.arm({
      id: bindingRead,
      kind: 'request',
      name: 'runtime.stand_in.binding',
      hold: false,
      afterReload: true,
    })
    // Adopt the entry URL without mounting its old renderer during the reload.
    await evaluate(`(() => {
      const directory = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1)
      history.replaceState(history.state, '', directory + 'stand-in')
    })()`)
    await reloadMainWindow(control, 'Assistant preference load must leave the desktop responsive')
    await gates.wait(preferencesRead.id)
    await assertGateClosed(startup)
    await rename(preferencesFile, original)
    moved = true
    await mkdir(preferencesFile)
    blocked = true
    await gates.reset(retain)
    await assertGateClosed(retry)

    await rmdir(preferencesFile)
    blocked = false
    await rename(original, preferencesFile)
    moved = false
    await gates.arm(preferencesRead)
    await control.command('clickWhenEnabled', retry)
    await gates.wait(preferencesRead.id)
    await assertGateClosed(loading)
    await gates.reset(retain)
    await control.command('waitFor', workspace, { visible: true })
  } finally {
    try {
      if (blocked) await rmdir(preferencesFile)
      if (moved) await rename(original, preferencesFile)
    } finally {
      await gates.reset()
    }
  }
}

const bindingWrites = [
  'bind',
  'prepareBind',
  'prepareReplacement',
  'completeActivation',
  'beginStop',
  'completeStop',
]
const mutationRules = [
  { id: 'assistant-lifecycle', name: 'runtime.stand_in.personal.lifecycle' },
  ...bindingWrites.map(operation => ({
    id: `assistant-binding-${operation}`,
    name: 'runtime.stand_in.binding',
    where: [{ path: 'params.operation', equals: operation }],
  })),
]

export async function openAssistantDashboard(control) {
  await control.command('waitFor', `${dashboard}, ${input}`, { visible: true })
  if ((await control.command('getElementCount', dashboard, { visible: true })) !== '0')
    await control.command('clickWhenEnabled', dashboard)
  await control.command('waitFor', input, { visible: true })
}

export async function verifyAssistantEntrySingleton(control, readBinding) {
  const gates = runtimeTransportGates(control)
  const armMutations = async afterReload => {
    for (const rule of mutationRules)
      await gates.arm({ ...rule, kind: 'request', hold: false, afterReload })
  }
  const binding = await readBinding()
  assert.equal(binding.status, 'unbound')
  const assertSingle = async (activePage, activeSubscriptions) => {
    if (activePage === input) await openAssistantDashboard(control)
    await control.command('waitFor', activePage, { visible: true })
    assert.equal(await control.command('getElementCount', workspace), '1')
    assert.equal(
      await control.command('getElementCount', activePage === input ? legacy : experience),
      '0'
    )
    let count = 0
    for (const name of await getAssistantMarks()) {
      if (!name.startsWith('wework:assistant-source-')) continue
      count += name.endsWith('-unsubscribe') ? -1 : 1
      assert.ok(count === 0 || count === 1, 'Assistant settings subscriptions overlapped')
    }
    assert.equal(count, activeSubscriptions)
    assert.deepEqual(await readBinding(), binding, 'Navigation changed the assistant binding')
    for (const rule of mutationRules)
      assert.equal(await gates.read(rule.id), null, `Navigation issued ${rule.id}`)
  }

  try {
    await armMutations(false)
    await assertSingle(input, 1)
    await control.command('navigate', 'body', { value: '/stand-in?view=scheduled' })
    await assertSingle(legacy, 0)
    await evaluate('history.back()')
    await assertSingle(input, 1)
    await evaluate('history.forward()')
    await assertSingle(legacy, 0)
    await evaluate('history.back()')
    await assertSingle(input, 1)
    for (const enabled of [false, true]) {
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ collaborationExperienceEnabled: enabled }),
      })
      await assertSingle(enabled ? input : legacy, Number(enabled))
    }

    await gates.reset()
    await armMutations(true)
    await reloadMainWindow(control, 'The assistant must restore its workspace after reload')
    await assertSingle(input, 1)
  } finally {
    await gates.reset()
  }
}
