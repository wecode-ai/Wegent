import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { modelRequestTexts } from './model-tool-output.mjs'
import { setNativeCatalogOverride } from './model-catalog-recovery.mjs'
import { selectedToolCall } from './model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  handleEmptyReplyPrediction,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
  selectTool,
  toolOutputText,
} from './response-protocol.mjs'
import {
  ACTIVE_COMPOSER_SELECTOR,
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  selectE2EModel,
} from './shared.mjs'

const PROMPT = 'Wework stops responding when I open a task.'
const QUESTION = 'How do you want to handle this Wework problem?'
const EXPLANATION = 'I can inspect local diagnostics. A source fix may require downloading Wegent.'
const MODES = ['Report a Bug', 'Try to fix it']
const RESULTS = ['Bug report prepared for review', 'Source fix verified']
const SKILL_SOURCE = 'git clone --no-checkout https://github.com/wecode-ai/Wegent.git'
const CARD = `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="request-user-input-card"]`
const STEP_TIMEOUT = 10_000

export function createRepairWeWorkFlow(workspacePath) {
  let mode = null
  let questionSent = false
  let fixture
  let revision
  const git = (...args) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8' }).trim()

  return {
    async handleHttp(request, response, url) {
      if (
        mode === null ||
        request.method !== 'POST' ||
        !['/responses', '/v1/responses'].includes(url.pathname)
      ) {
        return false
      }

      const body = await readRequestBody(request)
      if (handleEmptyReplyPrediction(body, response)) return true
      const input = modelRequestTexts(body, 'user')
      if (!input.includes(PROMPT)) return false
      assert.ok(input.includes(SKILL_SOURCE), 'Codex did not load the bundled Skill')

      const answered = input.split('\n').some(line => line.trim() === MODES[mode])
      const id = `repair-wework-${mode}-${Date.now()}`
      let events
      if (!questionSent) {
        events = [
          assistantMessage(EXPLANATION),
          ...selectedToolCall(
            `repair-wework-mode-${mode}`,
            selectTool(body, 'request_user_input_async', {
              questions: [{ title: QUESTION, options: MODES }],
            })
          ),
        ]
      } else if (!answered) {
        events = [assistantMessage('Waiting for the troubleshooting choice.')]
      } else if (!requestContainsToolOutput(body, `repair-wework-instance-${mode}`)) {
        events = mcpToolRequestEvents(body, {
          toolName: 'get_instance',
          directToolName: 'mcp__wework_diagnostics__get_instance',
          argumentsValue: {},
          searchCallId: `repair-wework-instance-search-${mode}`,
          toolCallId: `repair-wework-instance-${mode}`,
        }).events
      } else if (!requestContainsToolOutput(body, `repair-wework-traces-${mode}`)) {
        events = mcpToolRequestEvents(body, {
          toolName: 'read_trace_logs',
          directToolName: 'mcp__wework_diagnostics__read_trace_logs',
          argumentsValue: {},
          searchCallId: `repair-wework-traces-search-${mode}`,
          toolCallId: `repair-wework-traces-${mode}`,
        }).events
      } else if (mode === 0 && !requestContainsToolOutput(body, 'repair-wework-transport')) {
        assert.match(toolOutputText(body, 'repair-wework-traces-0'), /executor-transport\.log/)
        events = mcpToolRequestEvents(body, {
          toolName: 'read_trace_logs',
          directToolName: 'mcp__wework_diagnostics__read_trace_logs',
          argumentsValue: { source: 'executor-transport.log' },
          searchCallId: 'repair-wework-transport-search',
          toolCallId: 'repair-wework-transport',
        }).events
      } else if (mode === 0) {
        const log = JSON.parse(toolOutputText(body, 'repair-wework-transport'))
        assert.equal(log.source, 'executor-transport.log')
        assert.ok(log.text.length > 0, 'The current instance must provide its transport trace')
        const exportedLog = await readFile(log.logPath, 'utf8')
        assert.ok(
          exportedLog.endsWith(log.text),
          'The local trace must preserve the full redacted excerpt'
        )
        events = [assistantMessage(RESULTS[mode])]
      } else if (!requestContainsToolOutput(body, 'repair-wework-renderer')) {
        events = mcpToolRequestEvents(body, {
          toolName: 'record_renderer',
          directToolName: 'mcp__wework_diagnostics__record_renderer',
          argumentsValue: { durationMs: 1_000 },
          searchCallId: 'repair-wework-renderer-search',
          toolCallId: 'repair-wework-renderer',
        }).events
      } else if (!requestContainsToolOutput(body, 'repair-wework-heap')) {
        events = mcpToolRequestEvents(body, {
          toolName: 'export_renderer_heap',
          directToolName: 'mcp__wework_diagnostics__export_renderer_heap',
          argumentsValue: {},
          searchCallId: 'repair-wework-heap-search',
          toolCallId: 'repair-wework-heap',
        }).events
      } else if (!requestContainsToolOutput(body, 'repair-wework-checkout')) {
        const recording = JSON.parse(toolOutputText(body, 'repair-wework-renderer'))
        const instance = JSON.parse(toolOutputText(body, 'repair-wework-instance-1'))
        assert.match(instance.instanceId, /^main-/)
        assert.ok(instance.mainPid > 0 && instance.executorPid > 0)
        assert.equal(recording.pid, instance.rendererPid)
        assert.ok(recording.webContentsId > 0)
        const [trace, profile, consoleLog] = await Promise.all(
          [recording.tracePath, recording.profilePath, recording.consolePath].map(async path => {
            assert.match(path, /diagnostics[/\\]renderer-/)
            return JSON.parse(await readFile(path, 'utf8'))
          })
        )
        assert.ok(trace.traceEvents.length > 0, 'The live Chromium trace must contain events')
        assert.ok(profile.nodes.length > 0, 'The live CPU profile must contain stack frames')
        assert.ok(Array.isArray(consoleLog.events), 'The renderer console export must be readable')
        const heap = JSON.parse(toolOutputText(body, 'repair-wework-heap'))
        assert.equal(heap.webContentsId, recording.webContentsId)
        assert.equal(heap.pid, recording.pid)
        assert.match(heap.heapPath, /renderer\.heapsnapshot$/)
        const file = await open(heap.heapPath, 'r')
        try {
          const header = Buffer.alloc(128)
          await file.read(header)
          assert.match(header.toString('utf8'), /"snapshot"\s*:/)
        } finally {
          await file.close()
        }
        events = selectedToolCall(
          'repair-wework-checkout',
          selectTool(body, 'exec_command', {
            cmd: 'node repair-checkout.cjs',
            workdir: fixture,
            max_output_tokens: 500,
          })
        )
      } else {
        assert.ok(
          toolOutputText(body, 'repair-wework-checkout').includes(`Repair verified at ${revision}`),
          'The real Executor must reproduce and verify the patch in the isolated checkout'
        )
        events = [assistantMessage(RESULTS[mode])]
      }
      questionSent = true
      response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      response.end(createSse([responseCreated(id), ...events, responseCompleted(id)]))
      return true
    },
    async verify(control) {
      await setNativeCatalogOverride(
        control,
        DEFAULT_MODEL_ID,
        { experimental_supported_tools: ['request_user_input_async'] },
        STEP_TIMEOUT
      )
      fixture = await mkdtemp(join(workspacePath, 'repair-wework-'))
      try {
        git('init', '--quiet', 'source')
        await writeFile(join(fixture, 'source', 'status.cjs'), "module.exports = 'stalled'\n")
        git('-C', 'source', 'add', 'status.cjs')
        git(
          '-C',
          'source',
          '-c',
          'user.name=Wework E2E',
          '-c',
          'user.email=wework-e2e@example.invalid',
          'commit',
          '--quiet',
          '-m',
          'Fixture'
        )
        revision = git('-C', 'source', 'rev-parse', 'HEAD')
        await writeFile(
          join(fixture, 'repair-checkout.cjs'),
          `const { execFileSync } = require('node:child_process')
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
git('clone', '--quiet', '--no-checkout', 'source', 'checkout')
git('-C', 'checkout', 'worktree', 'add', '--quiet', '--detach', '../repair-worktree', '${revision}')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const status = './repair-worktree/status.cjs'
assert.equal(require(status), 'stalled')
fs.writeFileSync(status, "module.exports = 'ready'\\n")
delete require.cache[require.resolve(status)]
assert.equal(require(status), 'ready')
console.log('Repair verified at ' + git('-C', 'repair-worktree', 'rev-parse', 'HEAD'))
`
        )
        for (const [index, label] of MODES.entries()) {
          mode = index
          questionSent = false
          await control.command('clickWhenEnabled', '[data-testid="topnav-feedback-button"]', {
            timeoutMs: STEP_TIMEOUT,
          })
          await control.command('fill', '[data-testid="task-feedback-note"]', { value: PROMPT })
          await control.command('clickWhenEnabled', '[data-testid="task-feedback-repair-button"]', {
            timeoutMs: STEP_TIMEOUT,
          })
          await control.command('waitFor', '[data-testid="task-feedback-dialog-overlay"]', {
            visible: false,
            timeoutMs: STEP_TIMEOUT,
          })
          await control.command('waitFor', ACTIVE_COMPOSER_SELECTOR, {
            text: PROMPT,
            timeoutMs: STEP_TIMEOUT,
          })
          const skillPath = await control.command(
            'getAttribute',
            `${ACTIVE_COMPOSER_SELECTOR} [data-composer-skill-path]`,
            { value: 'data-composer-skill-path' }
          )
          assert.match(skillPath, /repair-wework[/\\]SKILL\.md$/)
          assert.equal(questionSent, false, 'Opening the entry submitted the draft before review')

          await selectE2EModel(control)
          await control.command(
            'clickWhenEnabled',
            `${ACTIVE_WORKBENCH_SELECTOR} [data-testid="send-message-button"]`,
            { timeoutMs: STEP_TIMEOUT }
          )
          await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
            text: EXPLANATION,
            timeoutMs: STEP_TIMEOUT,
          })
          await control.command('waitFor', CARD, { text: QUESTION, timeoutMs: STEP_TIMEOUT })
          const option = `${CARD} [data-testid^="request-user-input-option-"][data-testid$="-${index}"]`
          assert.ok((await control.command('getText', option)).includes(label))
          await control.command('clickWhenEnabled', option, { timeoutMs: STEP_TIMEOUT })
          await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
            text: RESULTS[index],
            timeoutMs: index === 0 ? STEP_TIMEOUT : 30_000,
          })
          if (index === 0) {
            await assert.rejects(access(join(fixture, 'checkout')), { code: 'ENOENT' })
          } else {
            assert.equal(git('-C', 'repair-worktree', 'rev-parse', 'HEAD'), revision)
            assert.equal(git('-C', 'repair-worktree', 'diff', '--name-only'), 'status.cjs')
            assert.equal(
              git('-C', 'checkout', 'show', `${revision}:status.cjs`),
              "module.exports = 'stalled'"
            )
          }
        }
      } finally {
        mode = null
        await rm(fixture, { recursive: true, force: true })
      }
    },
  }
}
