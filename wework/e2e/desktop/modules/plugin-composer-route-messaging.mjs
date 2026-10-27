import assert from 'node:assert/strict'
import { resolve } from 'node:path'

import { inputUserMessageTexts, requestContainsSkillLocator } from './desktop-server.mjs'
import { inventory, materializedPlugin, testId, until } from './plugin-regression-fixture.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_STEP_TIMEOUT_MS,
  selectE2EModel,
} from './shared.mjs'

// Wait for the production 30-second inventory TTL instead of changing renderer caches or clocks.
const INVENTORY_EXPIRY_MS = 31_000
const INVENTORY_EXPIRY_TIMEOUT_MS = 90_000

export function createPluginComposerRouteMessaging({ executorHome, timeoutMs }) {
  const evidence = []
  let activeMessage = null

  async function openPicker(control) {
    await control.command('click', testId('new-chat-button'))
    await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR)
    await control.command('click', testId('composer-plugin-picker-button'))
    await control.command('waitFor', testId('composer-plugin-picker'))
  }

  async function send(control, label, fixture) {
    const prompt = `WEWORK_PLUGIN_ROUTE_${label}`
    const completion = `${prompt}_COMPLETE`
    const runtime = fixture ? await materializedPlugin(executorHome, fixture.installedId) : null
    if (fixture) assert.ok(runtime?.runtime?.codex_link, 'The selected plugin is not materialized')
    activeMessage = {
      label,
      prompt,
      completion,
      plugin: fixture?.slug ?? null,
      skillPath: fixture
        ? resolve(
            executorHome,
            'capabilities',
            runtime.runtime.codex_link,
            'skills',
            fixture.slug,
            'SKILL.md'
          )
        : null,
      modelRequestObserved: false,
    }
    await control.command('click', testId('new-chat-button'))
    await selectE2EModel(control)
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: prompt })
    if (fixture) {
      await control.command('click', testId('composer-plugin-picker-button'))
      await control.command('waitFor', testId('composer-plugin-picker'))
      await control.command('fill', testId('composer-plugin-picker-search'), {
        value: fixture.slug,
      })
      await control.command(
        'clickWhenEnabled',
        testId(`composer-plugin-picker-item-plugin:${fixture.slug}`)
      )
      const reference = await control.command(
        'getAttribute',
        testId(`composer-plugin-chip-${fixture.slug}`),
        {
          value: 'data-composer-skill-reference',
        }
      )
      assert.ok(
        reference?.includes(`plugin://${fixture.slug}@wegent`),
        'Picker lost the plugin reference'
      )
    }
    await control.command('clickWhenEnabled', testId('send-message-button'))
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('message-assistant')}`,
      {
        text: completion,
        timeoutMs,
      }
    )
    assert.equal(
      activeMessage.modelRequestObserved,
      true,
      'The real Codex did not send the message to the model'
    )
    await control.command(
      'waitFor',
      `${ACTIVE_WORKBENCH_SELECTOR} ${testId('pause-response-button')}`,
      { visible: false }
    )
    evidence.push({ case: label, prompt, completion, plugin: fixture?.slug ?? null })
    activeMessage = null
  }

  function assertReadsTargetCurrentRuntime(transport, offset, routeId) {
    const reads = transport.writes
      .slice(offset)
      .filter(request => request.method === 'GET' && request.path === '/api/plugins/installed')
    assert.ok(
      reads.length > 0,
      'Composer reused a warm cache instead of reading real account inventory'
    )
    assert.ok(
      reads.every(request => request.deviceId === routeId),
      'Composer inventory bypassed the current Runtime route'
    )
    return reads
  }

  async function waitForInventoryExpiry(proxy) {
    console.log(
      '[plugin-runtime-route-refresh] Waiting for the real composer inventory cache to expire after all HTTP reads complete'
    )
    let lastState = null
    let lastActivityAt = Date.now()
    let previousCounts = ''
    try {
      await until(
        () => {
          const reads = proxy.requests.filter(
            request => request.method === 'GET' && request.path === '/api/plugins/installed'
          )
          const completed = reads.filter(request => request.delivered).length
          const counts = `${reads.length}:${completed}`
          if (counts !== previousCounts) {
            lastActivityAt = Date.now()
            previousCounts = counts
          }
          lastState = {
            requested: reads.length,
            completed,
            lastStatus: reads.at(-1)?.status ?? null,
            quietMs: Date.now() - lastActivityAt,
          }
          return lastState
        },
        state =>
          state.requested > 0 &&
          state.requested === state.completed &&
          state.quietMs >= INVENTORY_EXPIRY_MS,
        'Composer inventory did not become expired after its real reads completed',
        INVENTORY_EXPIRY_TIMEOUT_MS
      )
    } catch (error) {
      throw new Error(`${error.message}; HTTP state=${JSON.stringify(lastState)}`)
    }
    evidence.push({ case: 'composer-inventory-cache-expired', ...lastState })
  }

  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      assert.ok(activeMessage, 'Unexpected model request outside the composer message cases')
      const userInput = inputUserMessageTexts(body).find(text =>
        text.includes(activeMessage.prompt)
      )
      assert.ok(userInput, 'Model user input lost the submitted message')
      if (activeMessage.plugin) {
        // Executor converts the native plugin reference into @name in the user
        // turn. A match in the system skill catalog alone cannot prove selection.
        assert.ok(
          userInput.includes(`@${activeMessage.plugin}`),
          'The selected plugin reference did not reach the submitted user turn'
        )
        assert.ok(
          requestContainsSkillLocator(body, activeMessage.skillPath, activeMessage.plugin),
          'The real Codex did not discover the selected current-Runtime plugin skill'
        )
      }
      evidence.push({ case: 'model-user-input', label: activeMessage.label, userInput })
      activeMessage.modelRequestObserved = true
      const id = `plugin-route-${activeMessage.label}`
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end(
        createSse([
          responseCreated(id),
          assistantMessage(activeMessage.completion),
          responseCompleted(id),
        ])
      )
      return true
    },

    async verify(control, fixture, { proxy, transport, routeId, stableDeviceId }) {
      await send(control, 'ORDINARY_MESSAGE')
      await send(control, 'SELECTED_PLUGIN_MESSAGE', fixture)
      await waitForInventoryExpiry(proxy)
      const requestOffset = proxy.requests.length
      const readOffset = transport.writes.length
      proxy.rule = request =>
        request.method === 'GET' && request.path === '/api/plugins/installed'
          ? 'drop-response'
          : null
      try {
        await openPicker(control)
        const failure = await until(
          () => proxy.requests.slice(requestOffset),
          requests =>
            requests.some(
              request =>
                request.path === '/api/plugins/installed' && request.committedResponseDropped
            ),
          'The real composer inventory read did not exercise the configured transport failure',
          DEFAULT_STEP_TIMEOUT_MS
        ).then(requests =>
          requests.find(
            request => request.path === '/api/plugins/installed' && request.committedResponseDropped
          )
        )
        assert.equal(
          failure.status,
          200,
          'The fault did not interrupt a real successful backend response'
        )
        const reads = assertReadsTargetCurrentRuntime(transport, readOffset, routeId)
        await control.command('click', testId('composer-plugin-picker-button'))
        await send(control, 'ORDINARY_MESSAGE_WITH_CATALOG_FAILURE')
        assert.equal(proxy.rule({ method: 'GET', path: '/api/plugins/installed' }), 'drop-response')
        evidence.push({
          case: 'catalog-read-failure-does-not-block-send',
          reads,
          fault: 'drop-response',
        })
      } finally {
        proxy.rule = () => null
      }
      const recoveryOffset = transport.writes.length
      const recoveryRequestOffset = proxy.requests.length
      await openPicker(control)
      const response = await until(
        () => proxy.requests.slice(recoveryRequestOffset),
        requests =>
          requests.some(
            request =>
              request.method === 'GET' &&
              request.path === '/api/plugins/installed' &&
              request.status === 200 &&
              request.delivered
          ),
        'Composer did not complete a real successful inventory read after transport recovery',
        DEFAULT_STEP_TIMEOUT_MS
      ).then(requests =>
        requests.find(
          request =>
            request.method === 'GET' &&
            request.path === '/api/plugins/installed' &&
            request.status === 200 &&
            request.delivered
        )
      )
      const reads = assertReadsTargetCurrentRuntime(transport, recoveryOffset, routeId)
      await control.command('fill', testId('composer-plugin-picker-search'), {
        value: fixture.slug,
      })
      await control.command(
        'waitFor',
        testId(`composer-plugin-picker-item-plugin:${fixture.slug}`),
        { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      const state = await until(
        () => inventory(control),
        value =>
          value.sharedInventory.deviceId === stableDeviceId &&
          value.sharedInventory.installedPlugins.find(plugin => plugin.pluginKey === fixture.slug)
            ?.enabled === true &&
          value.composerApps.find(plugin => plugin.pluginKey === fixture.slug)?.isEnabled === true,
        'The recovered real inventory did not reach shared membership and Composer',
        DEFAULT_STEP_TIMEOUT_MS
      )
      assert.equal(
        state.sharedInventory.deviceId,
        stableDeviceId,
        'Composer routing changed the stable inventory identity'
      )
      assert.equal(
        state.sharedInventory.installedPlugins.find(plugin => plugin.pluginKey === fixture.slug)
          ?.enabled,
        true
      )
      assert.equal(
        state.composerApps.find(plugin => plugin.pluginKey === fixture.slug)?.isEnabled,
        true
      )
      evidence.push({
        case: 'composer-catalog-recovers-on-current-runtime',
        reads,
        response: { status: response.status, delivered: response.delivered },
        inventory: state,
      })
      await control.command('click', testId('composer-plugin-picker-button'))
    },
    diagnostics: () => ({ activeMessage, evidence }),
  }
}
