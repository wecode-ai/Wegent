import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

export async function verifyBrowserHistoryResume(control, resultDir, timeoutMs) {
  const address = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body')).workbench
    .currentRuntimeTask
  assert.ok(address?.taskId)
  const threadId = await waitForCompletedRuntimeTaskThread(control, address.taskId, timeoutMs)
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const restart = await rpc('runtime.codex.app_server.restart', { ifIdle: true })
  assert.equal(restart.restarted, true, 'Cold history recovery requires the old MCP pool to stop')

  // No new user turn runs between restart and history refresh. Native startup
  // must connect the task's MCP servers here, before any Goal can continue.
  await rpc('runtime.tasks.transcript', { address, refresh: true })
  await waitForValue(
    async () => {
      const log = await readFile(join(resultDir, 'executor.log'), 'utf8')
      const startup = log.lastIndexOf('codex shared app-server process initialized')
      assert.ok(startup >= 0, 'The restarted real Codex app-server must initialize')
      const current = log.slice(startup).split('\n')
      return ['wework_browser', 'wework_space'].filter(server =>
        current.some(
          line =>
            line.includes('codex MCP startup status') &&
            line.includes(`thread_id=${threadId} `) &&
            line.includes(`server_name=${server} status=ready`)
        )
      )
    },
    ready => ready.length === 2,
    'Cold history resume must connect browser and project tools without another model turn',
    timeoutMs
  )
}
