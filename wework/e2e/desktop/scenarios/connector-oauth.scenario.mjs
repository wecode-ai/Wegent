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

import { ACTIVE_COMPOSER_SELECTOR, ACTIVE_WORKBENCH_SELECTOR } from '../modules/shared.mjs'
import {
  CONNECTOR_OAUTH_SLUG,
  startConnectorOAuthProvider,
} from '../modules/connector-oauth-provider.mjs'
import {
  assistantMessage,
  readRequestBody,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PROMPT = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_PROMPT'
const RESUME_COMPLETION = 'WEWORK_DESKTOP_E2E_CONNECTOR_OAUTH_RESUMED'
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

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let backend
  let cloudEnvironment
  let provider
  let connectorAppId = 0
  const modelRequests = []
  let replySequence = 0

  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${backend.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${backend.authToken}`,
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
      if (isResumeRequest(body)) {
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
      await cloudEnvironment.waitForConnectedAppDevice()
      await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('fill', ACTIVE_COMPOSER_SELECTOR, { value: PROMPT })
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
      await control.command('clickWhenEnabled', '[data-testid="cloud-connector-auth-authorize"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="cloud-connector-auth-card"]', {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', '[data-testid="message-assistant"]', {
        text: RESUME_COMPLETION,
        timeoutMs: uiTimeoutMs,
      })

      assert.equal(provider.authorizeRequests, 1, 'The consent page must load exactly once')
      assert.equal(provider.tokenRequests, 1, 'The code exchange must run exactly once')

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

      await captureScreenshot(control, 'connector-oauth.png', ACTIVE_WORKBENCH_SELECTOR)
      assert.ok(connectorAppId > 0)
    },

    diagnostics() {
      return {
        modelRequests: modelRequests.length,
        authorizeRequests: provider?.authorizeRequests ?? 0,
        tokenRequests: provider?.tokenRequests ?? 0,
      }
    },

    async cleanup() {
      await provider?.close().catch(() => undefined)
    },
  }
}
