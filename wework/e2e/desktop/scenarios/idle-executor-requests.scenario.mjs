import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  collectProtocolEvents,
  createDevtoolsClient,
  writeDiagnosticFile,
} from '../../../scripts/ai-verify-devtools.mjs'
import { waitForWindowState } from '../modules/native-window-state.mjs'
import { verifyRuntimeWorkRefreshBurst } from '../modules/runtime-work-refresh-burst.mjs'
import { verifyPendingInventoryProjection } from '../modules/idle-executor-pending-inventory.mjs'
import { reloadMainWindow, waitForWorkbenchDebugState } from '../modules/workspace-flows.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  assertIdleExecutorTraffic,
  summarizeExecutorTraffic,
} from '../modules/idle-executor-requests.mjs'

const OBSERVATION_MS = 6_500

export function createDesktopScenario({ executorHome, resultDir, uiTimeoutMs }) {
  return {
    appEnvironment: {
      WEWORK_E2E_CLOUD_BACKEND_URL: '',
      VITE_WEWORK_E2E_CLOUD_BACKEND_URL: '',
      WEWORK_E2E_CLOUD_TOKEN: '',
      VITE_WEWORK_E2E_CLOUD_TOKEN: '',
      WEWORK_E2E_SEED_LOCAL_MODELS: 'false',
    },
    async verify(control) {
      const empty = snapshot =>
        snapshot.workbench?.isBootstrapping === false &&
        snapshot.workbench.runtimeWorkSummary?.totalTasks === 0 &&
        snapshot.workbench.runtimeWorkSummary?.runningTaskCount === 0 &&
        snapshot.workbench.devices?.length > 0
      await waitForWorkbenchDebugState(control, empty, 'The fixture must start without tasks')
      // Keep both bootstrap reconciliations from overlapping across the reload.
      const executorLog = join(resultDir, 'executor.log')
      await waitForValue(
        async () =>
          (await readFile(executorLog, 'utf8')).includes(
            'runtime work cached list reconciliation finished'
          ),
        Boolean,
        'Executor did not finish reconciling the initial task catalog',
        uiTimeoutMs
      )
      const client = await createDevtoolsClient(resultDir, uiTimeoutMs)
      const targets = await client({ action: 'targets' })
      const main = targets.find(
        target =>
          target.type === 'window' &&
          !target.url.startsWith('devtools:') &&
          !target.url.includes('startup-splash')
      )
      assert.ok(main, 'The real main renderer was not discoverable')
      const target = main.id
      const windows = []
      let rows = []
      try {
        await client({ action: 'command', target, method: 'Network.enable' })
        const before = await collectProtocolEvents(client, target)
        const read = async () => {
          const batch = await collectProtocolEvents(client, target, before.cursor)
          assert.equal(batch.lost, 0, 'Network evidence was discarded')
          assert.equal(batch.attached, true, 'The verification debugger detached')
          rows = summarizeExecutorTraffic(batch.events)
          return rows
        }
        await reloadMainWindow(control, 'The empty workbench did not reconnect after reload')
        await control.command('waitFor', '[data-testid="runtime-chat-empty"]', { visible: true })
        await waitForWorkbenchDebugState(control, empty, 'Reload created unexpected task state')
        const deadline = Date.now() + uiTimeoutMs
        while (Date.now() < deadline) {
          await read()
          if (
            ['runtime.worktrees.capabilities', 'runtime.stand_in.telemetry.configure'].every(
              method => rows.some(row => row.method === method && row.status === 200)
            )
          )
            break
          await delay(100)
        }
        assert.ok(
          rows.some(
            row => row.method === 'runtime.stand_in.telemetry.configure' && row.status === 200
          ),
          'Startup consent synchronization never completed'
        )
        assert.ok(
          rows.some(row => row.method === 'runtime.worktrees.capabilities' && row.status === 200),
          'Initial worktree capability discovery never completed'
        )
        await waitForValue(
          read,
          traffic =>
            traffic.some(
              row =>
                row.method === 'runtime.tasks.list' &&
                !row.pendingOnly &&
                !row.preferCached &&
                row.status === 200
            ),
          'The reloaded renderer did not read the reconciled task catalog',
          uiTimeoutMs
        )
        const observe = async name => {
          const start = Date.now()
          // Negative observation window, not a sleep used to infer UI readiness.
          await delay(OBSERVATION_MS)
          windows.push({ name, start, end: Date.now() })
          await read()
          await writeDiagnosticFile(join(resultDir, 'idle-executor-requests.json'), {
            rows,
            windows,
          })
        }
        await observe('foreground')
        await control.command('closeMainWindowToTray', 'body')
        await waitForWindowState(
          control,
          snapshot => snapshot.visible === false,
          'The isolated window did not enter background state',
          uiTimeoutMs
        )
        await observe('background')
        await waitForWorkbenchDebugState(control, empty, 'Idle observation changed task membership')
        assertIdleExecutorTraffic(rows, windows)
        await verifyRuntimeWorkRefreshBurst(control, read)
        await verifyPendingInventoryProjection(control, { executorHome, resultDir })
        return { idleExecutorRequests: true, observationMs: OBSERVATION_MS, windows }
      } finally {
        await client({ action: 'detach', target })
      }
    },
  }
}
