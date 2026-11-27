import assert from 'node:assert/strict'
import { mkdir, rename, rmdir } from 'node:fs/promises'
import { withProjectRenderer } from './project-create-test-utils.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from './shared.mjs'

const workspace = '[data-testid="personal-stand-in-workspace"]'
const accountSetup = '[data-testid="personal-assistant-account-setup"]'
const experience = '[data-testid="stand-in-experience"]'
const legacy = '[data-testid="stand-in-overview"]'
const input = `${experience} [data-testid="collaboration-exp-assistant-input"]`
const loading = '[data-testid="stand-in-preference-loading"]'
const retry = '[data-testid="stand-in-preference-retry"]'

function installEntryProbe(holdPreferences, assistantSelectors) {
  const fetchFromRenderer = window.fetch.bind(window)
  const reads = []
  const requests = []
  const mounts = []
  window.__standInEntryProbe = {
    reads,
    requests,
    mounts,
    holdPreferences,
    release() {
      for (const resolve of reads.splice(0)) resolve()
    },
  }
  if (holdPreferences) {
    const observer = new MutationObserver(records => {
      for (const { addedNodes } of records) {
        for (const node of addedNodes) {
          if (!(node instanceof Element)) continue
          const page = node.matches(assistantSelectors)
            ? node
            : node.querySelector(assistantSelectors)
          if (page) mounts.push(page.dataset.testid)
        }
      }
    })
    observer.observe(document, { childList: true, subtree: true })
    window.__standInEntryProbe.stopObserving = () => observer.disconnect()
  }
  window.fetch = async (resource, options) => {
    const path = new URL(resource instanceof Request ? resource.url : resource, location.href)
      .pathname
    if (path.endsWith('/v1/personal-assistant')) requests.push('account')
    if (typeof options?.body === 'string') {
      if (path === '/wework/executor/v1/rpc') {
        const { method, params } = JSON.parse(options.body)
        if (method?.startsWith('runtime.stand_in.'))
          requests.push([method, params?.operation].filter(Boolean).join(':'))
      } else if (
        window.__standInEntryProbe.holdPreferences &&
        path === '/wework/electron-host/v1/invoke'
      ) {
        const { capability, params } = JSON.parse(options.body)
        // Only postpone dispatch. The released request reads the real preferences file.
        if (capability === 'preferences.get' && params?.requireReadable === true)
          await new Promise(resolve => reads.push(resolve))
      }
    }
    return fetchFromRenderer(resource, options)
  }
}

export async function verifyAssistantPreferenceGate(control, preferencesFile) {
  return withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    const evaluate = async expression => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true })
      assert.equal(response.exceptionDetails, undefined, 'Could not read the assistant entry probe')
      return response.result?.value
    }
    const pages = [workspace, accountSetup, experience, legacy]
    const { identifier } = await command('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${installEntryProbe.toString()})(true, ${JSON.stringify(pages.join(', '))})`,
    })
    const original = `${preferencesFile}.assistant-e2e-original`
    let moved = false
    let blocked = false
    const assertGateClosed = async selector => {
      await control.command('waitFor', selector, { visible: true })
      for (const page of pages)
        assert.equal(await control.command('getElementCount', page), '0', `${page} mounted early`)
      assert.deepEqual(await evaluate('window.__standInEntryProbe.mounts'), [])
      assert.deepEqual(await evaluate('window.__standInEntryProbe.requests'), [])
      assert.deepEqual(await readAssistantSubscriptions(evaluate), [])
    }
    const waitForNativeRead = () =>
      waitForValue(
        () => evaluate('window.__standInEntryProbe?.reads.length'),
        count => count > 0,
        'The assistant gate must await the native preferences read',
        DEFAULT_STEP_TIMEOUT_MS
      )
    try {
      // Adopt the entry URL without mounting its old renderer during the reload.
      await evaluate(`(() => {
        const directory = location.pathname.slice(0, location.pathname.lastIndexOf('/') + 1)
        history.replaceState(history.state, '', directory + 'stand-in')
      })()`)
      await reloadMainWindow(control, 'Assistant preference load must leave the desktop responsive')
      await waitForNativeRead()
      await assertGateClosed(loading)
      await rename(preferencesFile, original)
      moved = true
      await mkdir(preferencesFile)
      blocked = true
      await evaluate('window.__standInEntryProbe.release()')
      await assertGateClosed(retry)

      await rmdir(preferencesFile)
      blocked = false
      await rename(original, preferencesFile)
      moved = false
      await control.command('clickWhenEnabled', retry)
      await waitForNativeRead()
      await assertGateClosed(loading)
      await evaluate('window.__standInEntryProbe.release()')
      await control.command('waitFor', workspace, { visible: true })
    } finally {
      try {
        if (blocked) await rmdir(preferencesFile)
        if (moved) await rename(original, preferencesFile)
      } finally {
        await command('Page.removeScriptToEvaluateOnNewDocument', { identifier })
        await evaluate(`if (window.__standInEntryProbe) {
          window.__standInEntryProbe.holdPreferences = false
          window.__standInEntryProbe.release()
          window.__standInEntryProbe.stopObserving?.()
        }`)
      }
    }
  })
}

function readAssistantSubscriptions(evaluate) {
  return evaluate(`performance.getEntriesByType('mark').map(entry => entry.name)
    .filter(name => /^wework:assistant-source-(un)?subscribe$/.test(name))`)
}

export async function verifyAssistantEntrySingleton(control, readBinding) {
  return withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    const evaluate = async expression => {
      const response = await command('Runtime.evaluate', { expression, returnByValue: true })
      assert.equal(response.exceptionDetails, undefined)
      return response.result?.value
    }
    const binding = await readBinding()
    assert.equal(binding.status, 'active')
    const mutationCount = () =>
      evaluate(`window.__standInEntryProbe.requests.filter(name =>
      name.startsWith('runtime.stand_in.personal.lifecycle:') ||
      (name.startsWith('runtime.stand_in.binding:') && !name.endsWith(':get'))).length`)
    const before = await mutationCount()
    assert.ok(before > 0, 'The probe must observe the real onboarding binding and lifecycle')
    const assertSingle = async (activePage, activeSubscriptions, initialMutations = before) => {
      await control.command('waitFor', activePage, { visible: true })
      assert.equal(await control.command('getElementCount', workspace), '1')
      assert.equal(
        await control.command('getElementCount', activePage === input ? legacy : experience),
        '0'
      )
      let count = 0
      for (const name of await readAssistantSubscriptions(evaluate)) {
        count += name.endsWith('-unsubscribe') ? -1 : 1
        assert.ok(count === 0 || count === 1, 'Assistant settings subscriptions overlapped')
      }
      assert.equal(count, activeSubscriptions)
      assert.deepEqual(await readBinding(), binding, 'Navigation changed the assistant binding')
      assert.equal(
        await mutationCount(),
        initialMutations,
        'Navigation bound or restarted the assistant'
      )
    }

    await assertSingle(input, 1)
    await control.command('navigate', 'body', { value: '/stand-in?view=messages' })
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
    const { identifier } = await command('Page.addScriptToEvaluateOnNewDocument', {
      source: `(${installEntryProbe.toString()})(false)`,
    })
    try {
      await reloadMainWindow(control, 'The assistant must restore its workspace after reload')
      await assertSingle(input, 1, 0)
    } finally {
      await command('Page.removeScriptToEvaluateOnNewDocument', { identifier })
    }
  })
}
