import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from './executor-rpc.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from './shared.mjs'
import { readMcpToolOutput } from './mcp-tool-results.mjs'
import { programmaticExecTools } from './model-tool-catalog.mjs'
import { selectedToolCall } from './model-tool-calls.mjs'
import {
  assistantMessage,
  createSse,
  mcpToolRequestEvents,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from './response-protocol.mjs'

const PREFIX = 'WEWORK_COMPUTER_LATE_ENABLE'
const TASK_ID = 'computer-use-late-enable'

/** Exercise the owning Executor's real task creation, native resume, and MCP routing. */
export function createComputerUseLateEnable({
  executorHome,
  resultDir,
  workspacePath,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  workbenchReadyTimeoutMs,
}) {
  const logPath = join(resultDir, 'executor.log')
  const completed = new Set()
  let phase = 'initial'
  let threadId
  let processId
  let hostPid
  let failure
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const currentProcess = async () =>
    [
      ...(await readFile(logPath, 'utf8')).matchAll(
        /codex shared app-server process starting process_id=(\d+)/g
      ),
    ].at(-1)?.[1]
  const run = async (control, nextPhase, create = false) => {
    phase = nextPhase
    const prompt = `${PREFIX}_${phase}`
    const result = await rpc(control, create ? 'runtime.tasks.create' : 'runtime.tasks.send', {
      taskId: TASK_ID,
      title: PREFIX,
      runtime: 'codex',
      workspacePath,
      message: prompt,
      ...(!create ? { threadId } : {}),
      executionRequest: {
        task_id: TASK_ID,
        subtask_id: `${TASK_ID}-${phase}`,
        prompt,
        project_workspace_path: workspacePath,
        new_session: create,
        bot: [{ shell_type: 'Codex', name: 'Computer use verification' }],
        model_config: { model_id: DEFAULT_MODEL_ID, model_provider: MODEL_PROVIDER_ID },
      },
    })
    assert.equal(result.accepted, true)
    const task = await waitForValue(
      async () => {
        if (failure) throw failure
        return (await rpc(control, 'runtime.tasks.get', { taskId: TASK_ID })).task
      },
      value =>
        completed.has(phase) && value?.status === 'done' && typeof value.threadId === 'string',
      `The original Wework task did not finish ${phase}`,
      modelResponseTimeoutMs
    )
    if (create) {
      threadId = task.threadId
      processId = await currentProcess()
      assert.ok(processId, 'The owning Executor did not publish its shared Codex PID')
    } else {
      assert.equal(task.threadId, threadId, 'Continuation replaced the original Wework thread')
      assert.equal(
        await currentProcess(),
        processId,
        'Computer use restarted the shared Codex process'
      )
    }
  }
  return {
    async prepare(control) {
      // Bundled synchronization can legitimately restart an idle shared client.
      // Establish the baseline only after those startup transactions finish.
      await waitForValue(
        async () => JSON.parse(await control.command('getBundledPluginUpdates', 'body')),
        value => {
          const names = value.marketplace?.defaultPluginNames ?? []
          return names.length > 0 && names.every(name => value.states[name]?.status === 'ready')
        },
        'Bundled plugins did not finish synchronization before the computer-use baseline',
        workbenchReadyTimeoutMs
      )
      await assert.rejects(access(join(executorHome, 'runtime/computer-use-bridge.json')), {
        code: 'ENOENT',
      })
      await run(control, 'initial', true)
    },
    async verify(control, record, recovered = false) {
      hostPid = record.pid
      await run(control, recovered ? 'recovered' : 'enabled')
    },
    verifyDisabled: control => run(control, 'disabled'),
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body.input ?? []).includes(PREFIX)) return false
      try {
        const id = `${PREFIX}-${phase}`
        const callId = `${id}-call`
        let events
        if (phase === 'initial' || requestContainsToolOutput(body, callId)) {
          if (phase !== 'initial') {
            const output = readMcpToolOutput(body, callId)
            if (phase === 'disabled')
              assert.match(
                output,
                /COMPUTER_TOOLS_DISABLED|Computer use bridge record is unavailable/
              )
            else
              assert.match(
                output,
                new RegExp(`"pid"\\s*:\\s*${hostPid}\\b`),
                'The real tool did not observe the isolated Wework host window'
              )
          }
          completed.add(phase)
          const message = assistantMessage(`${id}-complete`)
          events = [message, responseCompleted(id, [message.item])]
        } else if (phase === 'disabled') {
          const tools = programmaticExecTools(body)
          assert.equal(tools.length, 1)
          events = [
            ...selectedToolCall(callId, {
              name: tools[0].name,
              codeMode: {
                ...tools[0],
                input: [
                  'const matches = ALL_TOOLS.filter(tool => tool.name.includes("wework_computer") && tool.name.endsWith("list_windows"))',
                  'if (!matches.length) text("COMPUTER_TOOLS_DISABLED")',
                  `else { const result = await tools[matches[0].name]({pid:${hostPid}}); text(result) }`,
                ].join('\n'),
              },
            }),
            responseCompleted(id),
          ]
        } else {
          events = [
            ...mcpToolRequestEvents(body, {
              toolName: 'list_windows',
              argumentsValue: { pid: hostPid },
              directToolName: 'mcp__wework_computer__list_windows',
              searchCallId: `${id}-search`,
              toolCallId: callId,
            }).events,
            responseCompleted(id),
          ]
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(createSse([responseCreated(id), ...events]))
      } catch (error) {
        failure = error
        response.writeHead(500)
        response.end('Computer use model fixture failed')
      }
      return true
    },
    diagnostics: () => ({
      taskId: TASK_ID,
      threadId,
      processId,
      completed: [...completed],
      failure: failure?.message,
    }),
  }
}
