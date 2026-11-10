// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Desktop connector authorization checkpoint.
 *
 * The conversation hits a connector that needs authorization, the card opens
 * the real provider consent page in an in-app window, the provider redirects to
 * the real backend callback, and the blocked step continues with a single
 * continuation prompt. Nothing but the model service is faked.
 */

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  selectE2EModel,
} from '../modules/shared.mjs'
import {
  CONNECTOR_OAUTH_SLUG,
  startConnectorOAuthProvider,
} from '../modules/connector-oauth-provider.mjs'
import { verifyConnectorAccountSwitch } from '../modules/connector-account-switch.mjs'
import { openPlugin, testId, until } from '../modules/plugin-regression-fixture.mjs'
import {
  assistantMessage,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  toolOutputText,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_PROMPT'
const RESUME_COMPLETION = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_RESUMED'
const TOOL_PROMPT = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_CALL'
const TOOL_COMPLETION = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_TOOL_COMPLETED'
const TOOL_CALL_ID = 'connector-oauth-real-echo'
const CONNECTOR_PLUGIN_SLUG = 'desktop-connector-oauth-plugin'
/** `workbench.plugins_local_auth_resume_prompt` in both shipped locales. */
const RESUME_FRAGMENTS = ['blocked by authorization', '因授权中断']

function sse(events) {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

function writeReply(response, responseId, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
  response.end(
    sse([responseCreated(responseId), assistantMessage(text), responseCompleted(responseId)])
  )
}

/** The newest message of one model request, as text. */
function lastInputText(body) {
  const input = Array.isArray(body.input) ? body.input.at(-1) : body.input
  const message = Array.isArray(body.messages) ? body.messages.at(-1) : null
  return JSON.stringify(input ?? message ?? '')
}

function isResumeRequest(body) {
  const text = lastInputText(body)
  return RESUME_FRAGMENTS.some(fragment => text.includes(fragment))
}

export function createDesktopScenario({
  checkpoint,
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  let backend
  let cloudEnvironment
  let provider
  let connectorAppId = 0
  const modelRequests = []
  let replySequence = 0
  let catalogAtResume = null
  let localSyncHold = null
  let accountSwitch = null
  let connectorPlugin = null

  async function api(path, { method = 'GET', body, authToken = backend.authToken } = {}) {
    const response = await fetch(`${backend.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path} failed with HTTP ${response.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }

  return {
    requiresCloudEnvironment: true,

    async prepareCloud(environment) {
      backend = environment
      provider = await startConnectorOAuthProvider()
      await api('/api/admin/setup-complete', { method: 'POST' })
      const app = await api('/api/admin/connector-apps', {
        method: 'POST',
        body: {
          slug: CONNECTOR_OAUTH_SLUG,
          name: 'Desktop connector OAuth',
          description: 'Provider-backed connector used by the desktop checkpoint.',
          transport: 'streamable-http',
          mcp_url: `${provider.url}/mcp`,
          auth_type: 'oauth2',
          oauth_scope: 'mcp.read',
          tool_allowlist: [],
        },
      })
      connectorAppId = app.id
    },

    setCloudEnvironment(environment) {
      cloudEnvironment = environment
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
        return false
      }
      const body = await readRequestBody(request)
      modelRequests.push(body)
      const text = lastInputText(body)
      replySequence += 1
      if (JSON.stringify(body).includes(TOOL_PROMPT)) {
        if (requestContainsToolOutput(body, TOOL_CALL_ID)) {
          assert.ok(
            toolOutputText(body, TOOL_CALL_ID)?.includes('CONNECTOR-OAUTH-ECHO-OK'),
            'The authorized local MCP call must return the upstream success marker'
          )
          writeReply(response, `connector-oauth-tool-${replySequence}`, TOOL_COMPLETION)
          return true
        }
        const responseId = `connector-oauth-tool-${replySequence}`
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.end(
          sse([
            responseCreated(responseId),
            ...mcpToolRequestEvents(body, {
              toolName: 'echo',
              argumentsValue: { value: TOOL_PROMPT },
              directToolName: `mcp__wegent_apps__${CONNECTOR_OAUTH_SLUG}__echo`,
              searchCallId: `${TOOL_CALL_ID}-search`,
              toolCallId: TOOL_CALL_ID,
            }).events,
            responseCompleted(responseId),
          ])
        )
        return true
      }
      if (isResumeRequest(body)) {
        // Ordering evidence: by the time the blocked step resumes, the backend
        // catalog must already expose the connector's tools.
        const installed = await api('/api/apps/installed')
        const app = installed.apps.find(item => item.slug === CONNECTOR_OAUTH_SLUG)
        catalogAtResume = {
          status: app?.connection?.status ?? 'missing',
          tools: (app?.tool_summaries ?? []).map(tool => tool.raw_tool_name),
        }
        writeReply(response, `connector-oauth-resume-${replySequence}`, RESUME_COMPLETION)
        return true
      }
      if (text.includes(PROMPT)) {
        // The runtime reports the blocked connector the way the proxy does:
        // the agent ends its turn with the authorization hint.
        writeReply(
          response,
          `connector-oauth-blocked-${replySequence}`,
          `connector_auth_required\nconnectorSlug=${CONNECTOR_OAUTH_SLUG}`
        )
        return true
      }
      return false
    },

    async verify(control) {
      // Prediction requests also carry the conversation text; keep the model
      // fixture answering only real turns.
      await control.command('setAppPreferences', 'body', {
        value: JSON.stringify({ replyPredictionsEnabled: false }),
      })
      const appDevice = await cloudEnvironment.waitForConnectedAppDevice()
      // Standalone selection establishes its own app/provider and account
      // fixtures through prepareCloud and the shared account-switch flow.
      if (checkpoint === 'connector-account-switch') {
        accountSwitch = await verifyConnectorAccountSwitch({
          control,
          backend,
          api,
          slug: CONNECTOR_OAUTH_SLUG,
          mcpUrl: `${provider.url}/mcp`,
        })
        return
      }
      await selectE2EModel(control)
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
      await control.command(
        'waitFor',
        `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
        { enabled: true, timeoutMs: uiTimeoutMs }
      )
      await control.command('press', ACTIVE_COMPOSER_SELECTOR, { key: 'Enter' })

      await control.command('waitFor', '[data-testid="cloud-connector-auth-card"]', {
        timeoutMs: uiTimeoutMs,
      })
      const blockedSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        blockedSnapshot.testIds.includes('cloud-connector-auth-card'),
        'The blocked conversation must offer the connector authorization card'
      )

      // The card opens the provider inside the app; the provider auto-approves,
      // so the grant completes without leaving the workbench.
      //
      // Barrier: hold the local executor's connector sync so the checkpoint
      // proves the continuation waits for the runtime to apply the app list
      // instead of resuming as soon as the cloud catalog is ready.
      await control.command('holdLocalExecutorRequests', 'body', {
        value: JSON.stringify({
          method: 'runtime.connectors.apps.sync',
          phase: 'before-dispatch',
        }),
      })
      await control.command('clickWhenEnabled', '[data-testid="cloud-connector-auth-authorize"]', {
        timeoutMs: uiTimeoutMs,
      })
      const held = JSON.parse(await control.command('awaitLocalExecutorRequestHold', 'body'))
      localSyncHold = held
      assert.equal(held?.method, 'runtime.connectors.apps.sync')
      assert.ok(held.heldCount > 0, 'The consent flow never reached the local connector sync')
      const waitingSnapshot = JSON.parse(
        await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR)
      )
      assert.ok(
        waitingSnapshot.testIds.includes('cloud-connector-auth-card'),
        'The blocked step resumed before the local executor applied the connector'
      )
      assert.equal(
        modelRequests.filter(isResumeRequest).length,
        0,
        'The continuation must not start while the local connector sync is held'
      )
      await control.command('releaseLocalExecutorRequestHold', 'body')
      try {
        await control.command('waitFor', '[data-testid="cloud-connector-auth-card"]', {
          visible: false,
          timeoutMs: uiTimeoutMs,
        })
      } catch (error) {
        // Keep the failure debuggable: the card only stays when the resume
        // barrier never confirmed the app, so capture that state directly.
        await captureScreenshot(
          control,
          'connector-oauth-stuck.png',
          ACTIVE_WORKBENCH_SELECTOR
        ).catch(() => undefined)
        throw new Error(
          `The card did not clear after releasing the local connector sync ` +
            `(hold=${JSON.stringify(localSyncHold)}, ` +
            `resumeRequests=${modelRequests.filter(isResumeRequest).length}): ` +
            `${error?.message ?? error}`
        )
      }
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: RESUME_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(provider.authorizeRequests, 1, 'The consent page must load exactly once')
      assert.equal(provider.tokenRequests, 1, 'The code exchange must run exactly once')

      assert.ok(catalogAtResume, 'The blocked step never resumed')
      assert.equal(
        catalogAtResume.status,
        'connected',
        `The catalog did not see the stored grant at resume time: ${JSON.stringify(catalogAtResume)}`
      )
      assert.ok(
        catalogAtResume.tools.length > 0,
        `The blocked step resumed before the tool catalog synced: ${JSON.stringify(catalogAtResume)}`
      )

      const resumes = modelRequests.filter(isResumeRequest)
      assert.equal(resumes.length, 1, 'Authorization must resume the blocked step once')
      const resumedText = lastInputText(resumes[0])
      assert.ok(
        !resumedText.includes(PROMPT),
        'Resuming must not replay the original request as a new message'
      )

      const installed = await api('/api/apps/installed')
      const app = installed.apps.find(item => item.slug === CONNECTOR_OAUTH_SLUG)
      assert.equal(app?.connection.status, 'connected', 'The backend must store the grant')

      // An expired grant whose refresh is rejected must still recover through
      // provider consent from the installed plugin detail. Recreate the grant
      // through the real OAuth provider so it carries a renewable token.
      provider.setAccessTokenTtl(1)
      const expiredSession = await api(
        `/api/connector-apps/${CONNECTOR_OAUTH_SLUG}/oauth/sessions`,
        { method: 'POST' }
      )
      const expiredConsent = await fetch(expiredSession.authorize_url, { redirect: 'manual' })
      assert.equal(expiredConsent.status, 302)
      const expiredCallback = await fetch(expiredConsent.headers.get('location'))
      assert.equal(expiredCallback.status, 200)
      await until(
        () => api('/api/connector-apps'),
        apps =>
          apps.find(app => app.slug === CONNECTOR_OAUTH_SLUG)?.connection.status === 'expired',
        'The short-lived connector grant never expired',
        uiTimeoutMs
      )
      provider.setAccessTokenTtl(3600)
      provider.rejectRefresh(true)

      const pluginRoot = join(resultDir, 'connector-oauth-plugin')
      await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true })
      await writeFile(
        join(pluginRoot, '.codex-plugin/plugin.json'),
        `${JSON.stringify(
          {
            name: CONNECTOR_PLUGIN_SLUG,
            version: '1.0.0',
            description: 'Desktop connector authorization recovery fixture',
            connectors: [
              {
                slug: CONNECTOR_OAUTH_SLUG,
                displayName: 'Desktop connector OAuth',
                authPolicy: 'on_use',
              },
            ],
          },
          null,
          2
        )}\n`
      )
      connectorPlugin = await cloudEnvironment.publishPluginRelease({
        slug: CONNECTOR_PLUGIN_SLUG,
        version: '1.0.0',
        packageRoot: pluginRoot,
      })
      await api(
        `/api/plugins/marketplace/${connectorPlugin.pluginId}/install?device_id=${encodeURIComponent(
          appDevice.device_id
        )}`,
        { method: 'POST' }
      )
      await openPlugin(control, { slug: CONNECTOR_PLUGIN_SLUG })
      await control.command('clickWhenEnabled', testId('plugins-refresh-button'))
      const pluginRow = testId(`plugin-marketplace-row-${connectorPlugin.pluginId}`)
      await control.command('waitFor', pluginRow, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', pluginRow)
      const manage = `[data-testid="plugin-connection-manage-connector:${CONNECTOR_OAUTH_SLUG}"]`
      await control.command('waitFor', manage, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })

      const refreshBefore = provider.refreshRequests
      const authorizeBefore = provider.authorizeRequests
      const tokenBefore = provider.tokenRequests
      await control.command('clickWhenEnabled', manage, {
        timeoutMs: uiTimeoutMs,
      })
      await until(
        () => api('/api/connector-apps'),
        apps =>
          apps.find(app => app.slug === CONNECTOR_OAUTH_SLUG)?.connection.status === 'connected',
        'Provider consent did not restore the rejected connector grant',
        uiTimeoutMs
      )
      assert.equal(
        provider.refreshRequests,
        refreshBefore + 1,
        'The expired plugin connection must exercise exactly one rejected refresh'
      )
      assert.equal(
        provider.authorizeRequests,
        authorizeBefore + 1,
        'A rejected refresh must fall back to exactly one provider consent'
      )
      assert.equal(
        provider.tokenRequests,
        tokenBefore + 2,
        'The refresh and consent fallback must each reach the token endpoint once'
      )
      await control.command('waitFor', `${manage}:not([disabled])`, {
        enabled: true,
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command('getElementCount', '[data-testid="plugin-detail-action-error"]')
        ),
        0,
        'A rejected refresh must not leave a plugin authorization error'
      )
      await control.command('clickWhenEnabled', manage, { timeoutMs: uiTimeoutMs })
      await control.command(
        'waitFor',
        `[data-testid="connector-connection-${CONNECTOR_OAUTH_SLUG}"]`,
        { timeoutMs: uiTimeoutMs }
      )
      await control.command('navigate', 'body', { value: '/' })
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: workbenchReadyTimeoutMs,
      })

      // A catalog entry is not execution evidence. Send one new model turn
      // through the actual Codex -> local MCP -> backend -> upstream path.
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: TOOL_PROMPT })
      await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR, {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: TOOL_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })
      assert.deepEqual(provider.toolCalls, [{ name: 'echo', arguments: { value: TOOL_PROMPT } }])

      await captureScreenshot(control, 'connector-oauth.png', ACTIVE_WORKBENCH_SELECTOR)
      assert.ok(connectorAppId > 0)
      accountSwitch = await verifyConnectorAccountSwitch({
        control,
        backend,
        api,
        slug: CONNECTOR_OAUTH_SLUG,
        mcpUrl: `${provider.url}/mcp`,
      })
    },

    diagnostics() {
      return {
        modelRequests: modelRequests.length,
        authorizeRequests: provider?.authorizeRequests ?? 0,
        tokenRequests: provider?.tokenRequests ?? 0,
        refreshRequests: provider?.refreshRequests ?? 0,
        toolCalls: provider?.toolCalls ?? [],
        catalogAtResume,
        localSyncHold,
        accountSwitch,
        connectorPlugin,
      }
    },

    async cleanup() {
      await provider?.close().catch(() => undefined)
    },
  }
}
