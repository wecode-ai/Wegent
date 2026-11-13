import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { DEFAULT_MODEL_ID, MODEL_PROVIDER_ID } from '../modules/shared.mjs'
import { readMcpToolOutput } from '../modules/mcp-tool-results.mjs'
import { programmaticExecTools } from '../modules/model-tool-catalog.mjs'
import { selectedToolCall } from '../modules/model-tool-calls.mjs'
import { collectProcessInstanceIdentity } from '../process-instance.mjs'
import {
  assistantMessage,
  createSse,
  readRequestBody,
  requestContainsToolOutput,
  responseCompleted,
  responseCreated,
} from '../modules/response-protocol.mjs'

const PREFIX = 'MCP_RESUME_RECOVERY'
const NAMES = ['resume_healthy', 'resume_first', 'resume_second', 'resume_persistent']

/** Real production MCP binaries fail to spawn until their executable is restored.
 * Only model responses are simulated; no MCP implementation or transport is mocked.
 */
export function createDesktopScenario({
  executorHome,
  resultDir,
  workspacePath,
  uiTimeoutMs,
  workbenchReadyTimeoutMs,
  modelResponseTimeoutMs,
}) {
  const root = join(resultDir, 'mcp-resume-recovery')
  const log = join(resultDir, 'executor.log')
  const completed = new Set()
  const retainedProcesses = new Map()
  const executable = name =>
    join(root, 'bin', `${name}${process.platform === 'win32' ? '.exe' : ''}`)
  let phase = 'initial'
  let threadId
  let modelFailure
  const rpc = (control, method, params) => requestExecutor(control, method, params, uiTimeoutMs)
  const processId = async () =>
    [
      ...(await readFile(log, 'utf8')).matchAll(
        /codex shared app-server process starting process_id=(\d+)/g
      ),
    ].at(-1)?.[1]
  const starts = async name =>
    [
      ...(await readFile(join(root, name, 'wework-browser-mcp.log'), 'utf8')).matchAll(
        /lifecycle=start pid=(\d+)/g
      ),
    ].map(match => match[1])

  async function retain(name, pid) {
    const identity = await collectProcessInstanceIdentity(Number(pid))
    assert.ok(identity, `The real ${name} MCP process is no longer running`)
    retainedProcesses.set(name, identity)
  }

  async function retainReadyClient(name) {
    const identity = await waitForValue(
      async () => {
        const identities = await Promise.all(
          (await starts(name)).map(pid => collectProcessInstanceIdentity(Number(pid)))
        )
        return identities.filter(Boolean)
      },
      live => live.length === 1 && live[0],
      `The original ${name} MCP client did not remain uniquely identifiable after prediction forks exited`,
      uiTimeoutMs
    )
    retainedProcesses.set(name, identity)
  }

  async function assertRetained(names) {
    for (const name of names) {
      const expected = retainedProcesses.get(name)
      assert.deepEqual(
        await collectProcessInstanceIdentity(expected.pid),
        expected,
        `Recovery replaced the original ${name} MCP process`
      )
    }
  }

  async function run(control, next, create = false) {
    phase = next
    const prompt = `${PREFIX}_${phase}`
    const result = await rpc(control, create ? 'runtime.tasks.create' : 'runtime.tasks.send', {
      taskId: 'mcp-resume-recovery',
      title: PREFIX,
      runtime: 'codex',
      workspacePath,
      message: prompt,
      ...(!create ? { threadId } : {}),
      executionRequest: {
        task_id: 'mcp-resume-recovery',
        subtask_id: `mcp-resume-recovery-${phase}`,
        prompt,
        project_workspace_path: workspacePath,
        new_session: create,
        bot: [{ shell_type: 'Codex', name: 'MCP recovery verification' }],
        model_config: { model_id: DEFAULT_MODEL_ID, model_provider: MODEL_PROVIDER_ID },
      },
    })
    assert.equal(result.accepted, true)
    const task = await waitForValue(
      async () => {
        if (modelFailure) throw modelFailure
        return (await rpc(control, 'runtime.tasks.get', { taskId: 'mcp-resume-recovery' })).task
      },
      value =>
        completed.has(phase) && value?.status === 'done' && typeof value.threadId === 'string',
      `MCP recovery task did not finish ${phase}`,
      modelResponseTimeoutMs
    )
    if (create) threadId = task.threadId
    else assert.equal(task.threadId, threadId, 'Recovery replaced the original native conversation')
  }

  return {
    async verify(control) {
      await control.command('waitFor', '[data-testid="app-shell"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      // Prediction forks can start these same MCP binaries before the parent
      // thread recovers. Only the parent should populate the lifecycle logs.
      const preferences = JSON.parse(
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ replyPredictionsEnabled: false }),
        })
      )
      assert.equal(preferences.replyPredictionsEnabled, false)
      await waitForValue(
        async () => JSON.parse(await control.command('getBundledPluginUpdates', 'body')),
        value => {
          const names = value.marketplace?.defaultPluginNames ?? []
          return names.length > 0 && names.every(name => value.states[name]?.status === 'ready')
        },
        'Bundled synchronization did not settle before MCP recovery verification',
        workbenchReadyTimeoutMs
      )
      await mkdir(join(root, 'bin'), { recursive: true })
      for (const name of NAMES) {
        await mkdir(join(root, name), { recursive: true })
        await rpc(control, 'runtime.codex.app_server.request', {
          method: 'config/value/write',
          params: {
            keyPath: `mcp_servers.${name}`,
            value: {
              command: name === NAMES[0] ? process.env.WEWORK_E2E_EXECUTOR_BIN : executable(name),
              args: ['browser-mcp-server'],
              env: { WEGENT_EXECUTOR_LOG_DIR: join(root, name) },
              required: name === NAMES[0],
            },
            mergeStrategy: 'replace',
          },
        })
      }
      await run(control, 'initial', true)
      const pid = await processId()
      assert.ok(pid)
      const healthy = await starts(NAMES[0])
      assert.ok(healthy.length >= 1, 'The real healthy MCP did not start')
      await retain(NAMES[0], healthy[0])
      const initialLog = await readFile(log, 'utf8')
      for (const name of NAMES.slice(1))
        assert.match(
          initialLog,
          new RegExp(`thread_id=${threadId} server_name=${name} status=failed`)
        )

      for (const name of NAMES.slice(1, 3)) {
        await copyFile(
          process.env.WEWORK_E2E_EXECUTOR_BIN,
          `${executable(name)}.ready`,
          constants.COPYFILE_FICLONE
        )
        await rename(`${executable(name)}.ready`, executable(name))
      }
      await run(control, 'recovered')
      assert.equal(await processId(), pid, 'MCP recovery restarted the shared Codex process')
      // Prediction forks may start independent clients. Verify the original
      // connection's OS creation identity rather than counting all processes.
      await assertRetained([NAMES[0]])
      for (const name of NAMES.slice(1, 3)) {
        const pids = await starts(name)
        assert.ok(pids.length >= 1, `The real ${name} MCP did not start after recovery`)
        await retainReadyClient(name)
      }
      await run(control, 'stable')
      const recoveredLog = await readFile(log, 'utf8')
      assert.equal(
        recoveredLog
          .split('\n')
          .filter(line => line.includes(`codex MCP startup recovery thread_id=${threadId}`)).length,
        2,
        'Each new work admission must reconcile a persistent failure at most once'
      )
      await assertRetained(NAMES.slice(0, 3))
      assert.equal(await processId(), pid)

      // Native changes runtimeStatus when a connected transport exits, but
      // emits no new startup failure notification for this connection.
      const beforeExit = await starts(NAMES[1])
      const disconnectedPid = retainedProcesses.get(NAMES[1]).pid
      retainedProcesses.delete(NAMES[1])
      process.kill(disconnectedPid, 'SIGTERM')
      await waitForValue(
        () => collectProcessInstanceIdentity(disconnectedPid),
        identity => identity === null,
        'The owned MCP transport process did not terminate',
        uiTimeoutMs
      )
      await run(control, 'transport-recovered')
      assert.equal(await processId(), pid)
      await assertRetained([NAMES[0], NAMES[2]])
      const restarted = await starts(NAMES[1])
      assert.ok(
        restarted.some(value => !beforeExit.includes(value)),
        'The disconnected MCP did not start a replacement process'
      )
      // The model-visible catalog proves the replacement connection is ready.
      // Startup records also contain short-lived prediction clients, whose PID
      // cannot identify the recovered parent connection. Keep identity checks
      // scoped to the unaffected clients and bound recovery by native reloads.
      await run(control, 'transport-stable')
      await assertRetained([NAMES[0], NAMES[2]])
      assert.equal(
        (await readFile(log, 'utf8'))
          .split('\n')
          .filter(line => line.includes(`codex MCP startup recovery thread_id=${threadId}`)).length,
        4,
        'Each admitted execution must reconcile once without looping on persistent failure'
      )
      await copyFile(
        process.env.WEWORK_E2E_EXECUTOR_BIN,
        `${executable(NAMES[3])}.ready`,
        constants.COPYFILE_FICLONE
      )
      await rename(`${executable(NAMES[3])}.ready`, executable(NAMES[3]))
      await run(control, 'late-recovered')
      await run(control, 'late-stable')
      await assertRetained([NAMES[0], NAMES[2]])
      assert.equal(await processId(), pid)
      assert.equal(
        (await readFile(log, 'utf8'))
          .split('\n')
          .filter(line => line.includes(`codex MCP startup recovery thread_id=${threadId}`)).length,
        5,
        'A healthy work admission must not reload MCPs after the late service recovers'
      )
      console.log(
        '[mcp-resume-recovery] Startup failure, transport exit, original conversation, healthy PIDs, and bounded recovery verified'
      )
    },

    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/v1/responses', '/responses'].includes(url.pathname))
        return false
      const body = await readRequestBody(request)
      if (!JSON.stringify(body.input ?? []).includes(PREFIX)) return false
      try {
        const id = `${PREFIX}_${phase}`
        const callId = `${id}_catalog`
        let events
        if (requestContainsToolOutput(body, callId)) {
          const output = readMcpToolOutput(body, callId)
          assert.match(output, /RECOVERY_CATALOG_OK/)
          completed.add(phase)
          const message = assistantMessage(`${id}_done`)
          events = [message, responseCompleted(id, [message.item])]
        } else {
          const tools = programmaticExecTools(body)
          assert.equal(tools.length, 1)
          const expected =
            phase === 'initial'
              ? [true, false, false, false]
              : phase.startsWith('late-')
                ? [true, true, true, true]
                : [true, true, true, false]
          events = [
            ...selectedToolCall(callId, {
              name: tools[0].name,
              codeMode: {
                ...tools[0],
                input: `const names = ${JSON.stringify(NAMES)}; const expected = ${JSON.stringify(expected)}; const actual = names.map(name => ALL_TOOLS.some(tool => tool.name.includes(name + '__'))); if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('MCP catalogs differ: ' + JSON.stringify({actual, expected})); text('RECOVERY_CATALOG_OK')`,
              },
            }),
            responseCompleted(id),
          ]
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(createSse([responseCreated(id), ...events]))
      } catch (error) {
        modelFailure = error
        response.writeHead(500)
        response.end('MCP recovery model fixture failed')
      }
      return true
    },
    diagnostics: () => ({
      executorHome,
      threadId,
      completed: [...completed],
      retainedProcesses: Object.fromEntries(retainedProcesses),
      failure: modelFailure?.message,
    }),
  }
}
