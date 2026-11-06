import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_SEND_BUTTON_SELECTOR,
  createSingleRootLocalProject,
} from '../modules/shared.mjs'
import {
  assistantMessage,
  codexRequestKind,
  createSse,
  functionCall,
  handleEmptyReplyPrediction,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectShellToolCommand,
} from '../modules/response-protocol.mjs'
import { waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PREFIX = 'WEWORK_RUNTIME_POLICY'
const BEFORE = `${PREFIX}_OLD_RULE`
const AFTER = `${PREFIX}_CURRENT_RULE`
const SUMMARY = `${PREFIX}_SUMMARY`
const BROWSER_DETAIL =
  'On a transient action error, inspect the existing page and retry that action once'

function texts(body, role) {
  return (body.input ?? [])
    .filter(item => !role || item.role === role)
    .flatMap(item =>
      Array.isArray(item.content)
        ? item.content.map(part => part.text ?? '')
        : [item.content ?? item.output ?? '']
    )
    .join('\n')
}

function reply(response, id, events, tokens = 45_000) {
  const completed = responseCompleted(id)
  Object.assign(completed.response.usage, { input_tokens: tokens, total_tokens: tokens + 20 })
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(createSse([responseCreated(id), ...events, completed]))
}

export function createDesktopScenario(options) {
  let configPath
  let originalConfig
  let phase
  let callId
  let requests = 0
  let compactions = 0
  let browserPath
  let policyPath
  const evidence = []

  async function send(control, next) {
    phase = next
    callId = null
    await control.command('fill', ACTIVE_COMPOSER_SELECTOR, {
      value: next === 'plain' ? 'hi' : `${PREFIX}:${next}`,
    })
    await control.command('clickWhenEnabled', ACTIVE_SEND_BUTTON_SELECTOR)
    await control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${PREFIX}:${next}:done`,
      timeoutMs: options.modelResponseTimeoutMs,
    })
    return waitForWorkbenchDebugState(
      control,
      snapshot => snapshot.pane?.status?.isBusy === false,
      `Runtime policy ${next} did not settle`
    )
  }

  return {
    async prepareApp({ codexHome }) {
      configPath = join(codexHome, 'config.toml')
      originalConfig = await readFile(configPath, 'utf8')
      assert.doesNotMatch(originalConfig, /^developer_instructions\s*=/m)
      await writeFile(configPath, `developer_instructions = "${BEFORE}"\n${originalConfig}`)
    },
    async handleHttp(request, response, url) {
      if (
        !phase ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      )
        return false
      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const id = `runtime-policy-${++requests}`
      const kind = codexRequestKind(body)
      if (kind === 'prewarm') {
        reply(response, id, [], 0)
        return true
      }
      if (kind === 'compaction') {
        compactions += 1
        reply(response, id, [assistantMessage(SUMMARY)], 1200)
        return true
      }
      const developer = texts(body, 'developer')
      const all = texts(body)
      assert.doesNotMatch(developer, /<wework\.host-policy\.part-/)
      if (callId && requestContainsToolOutput(body, callId)) {
        if (phase === 'browser')
          assert.ok(
            all.includes(BROWSER_DETAIL),
            'The real shell did not load browser instructions'
          )
        else {
          const loaded = await readFile(policyPath, 'utf8')
          assert.ok(loaded.includes(AFTER))
          assert.ok(!loaded.includes(BEFORE))
          assert.ok(all.includes(AFTER), 'The updated policy never reached model input')
        }
        evidence.push({ phase, loaded: true })
        reply(response, id, [assistantMessage(`${PREFIX}:${phase}:done`)])
        return true
      }
      if (phase === 'plain') {
        await writeFile(
          join(options.resultDir, 'initial-model-request.json'),
          JSON.stringify(body, null, 2)
        )
        assert.equal(developer.split(BEFORE).length - 1, 1, 'Initial rules were duplicated')
        assert.ok(developer.includes('wework-runtime'))
        assert.ok(
          !developer.includes(BROWSER_DETAIL),
          'Unrelated browser details were eagerly loaded'
        )
        assert.ok(
          !developer.includes('window.openai'),
          'Unrelated visualization details were eagerly loaded'
        )
        const line = developer
          .split('\n')
          .find(line => line.startsWith('- wework-runtime:browser:'))
        const locator = line?.match(/\(file: ([^)]+)\)/)?.[1]
        assert.ok(
          locator,
          'Default browser skill metadata missing: ' +
            developer
              .split('\n')
              .filter(line => line.includes('wework-runtime'))
              .join('\n')
        )
        const roots = new Map(
          [...developer.matchAll(/^- `(r\d+)` = `([^`]+)`/gm)].map(match => [match[1], match[2]])
        )
        const [alias, ...relative] = locator.split('/')
        browserPath = roots.has(alias) ? join(roots.get(alias), ...relative) : locator
        assert.ok(
          browserPath.includes('wework-runtime'),
          'The resolved browser skill is outside the default plugin'
        )
      } else if (phase === 'browser' || phase === 'updated') {
        if (phase === 'updated') {
          policyPath = [...developer.matchAll(/read the complete policy skill at ("[^"\n]+")/g)].at(
            -1
          )?.[1]
          assert.ok(policyPath, 'The updated turn lost its current policy reference')
          policyPath = JSON.parse(policyPath)
        }
        const path = phase === 'browser' ? browserPath : policyPath
        const command = `cat '${path.replaceAll("'", "'\\''")}'`
        const tool = selectShellToolCommand(body, command, options.workspacePath)
        callId = `runtime-policy-${phase}`
        reply(response, id, selectedToolCall(callId, tool))
        return true
      } else {
        assert.ok(all.includes(SUMMARY), 'The real native compaction did not install its summary')
        assert.equal(
          developer.split(AFTER).length - 1,
          1,
          'Compaction/resume did not restore exactly one current policy'
        )
        assert.ok(!developer.includes(BEFORE), 'Compaction resurrected the old policy')
        assert.ok(!developer.includes(BROWSER_DETAIL), 'Compaction eagerly loaded browser details')
      }
      evidence.push({ phase, loaded: false })
      reply(response, id, [assistantMessage(`${PREFIX}:${phase}:done`)])
      return true
    },
    async verify(control) {
      await waitForValue(
        async () => JSON.parse(await control.command('getBundledPluginUpdates', 'body')),
        state => state.states?.['wework-runtime']?.status === 'ready',
        'The default runtime plugin was not installed',
        options.workbenchReadyTimeoutMs
      )
      await createSingleRootLocalProject(control, options.workspacePath, 'runtime-policy')
      await send(control, 'plain')
      await send(control, 'browser')
      const config = await readFile(configPath, 'utf8')
      await writeFile(configPath, config.replace(`"${BEFORE}"`, `"${AFTER}"`))
      await send(control, 'updated')
      await control.command('clickWhenEnabled', '[data-testid="context-usage-button"]')
      await control.command('clickWhenEnabled', '[data-testid="confirm-compact-context-button"]')
      await waitForWorkbenchDebugState(
        control,
        snapshot => compactions === 1 && snapshot.pane?.status?.isBusy === false,
        'The native compaction did not finish'
      )
      await send(control, 'compacted')
      const restarted = await waitForValue(
        async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
        result => result.restarted === true,
        'The native app server did not become idle before session restoration',
        options.uiTimeoutMs
      )
      assert.equal(restarted.restarted, true, 'The native session was not unloaded')
      await send(control, 'resumed')
      assert.deepEqual(
        evidence.map(item => item.phase),
        ['plain', 'browser', 'updated', 'compacted', 'resumed']
      )
      await writeFile(
        join(options.resultDir, 'runtime-policy-evidence.json'),
        JSON.stringify({ evidence, requests, compactions }, null, 2)
      )
    },
    async cleanup() {
      if (configPath && originalConfig !== undefined) await writeFile(configPath, originalConfig)
    },
  }
}
