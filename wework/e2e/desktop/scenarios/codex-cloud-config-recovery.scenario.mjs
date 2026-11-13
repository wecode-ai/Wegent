import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createCloudConfigModelService } from '../modules/cloud-config-model-service.mjs'
import { assertCloudConfigRecovery } from '../modules/cloud-config-recovery-evidence.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { restartCodexWhenIdle } from '../modules/executor-restart-readiness.mjs'
import {
  ACTIVE_WORKBENCH_SELECTOR,
  DEFAULT_MODEL_ID,
  DEFAULT_STEP_TIMEOUT_MS,
  MODEL_PROVIDER_ID,
  createSingleRootLocalProject,
  waitForLogPattern,
} from '../modules/shared.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const PREFIX = 'WEWORK_CLOUD_CONFIG_RECOVERY'
const OFFICIAL_MODEL = 'gpt-6.1-sol'
// Cold enterprise configuration retries and intentional desktop restarts are
// slow operations; ordinary UI actions retain the shared ten-second timeout.
const RECOVERY_TIMEOUT_MS = 60_000

async function preparePluginSyncFixture(resultDir) {
  const pluginName = 'cloud-config-auth-probe'
  const root = join(resultDir, 'cloud-config-marketplace')
  const manifestDirectory = join(root, '.agents', 'plugins')
  const pluginDirectory = join(root, 'plugins', pluginName, '.codex-plugin')
  await mkdir(manifestDirectory, { recursive: true })
  await mkdir(pluginDirectory, { recursive: true })
  const marketplacePath = join(manifestDirectory, 'marketplace.json')
  await writeFile(
    marketplacePath,
    JSON.stringify({
      name: 'wework-personal',
      plugins: [
        {
          name: pluginName,
          source: { source: 'local', path: `plugins/${pluginName}` },
          policy: { installation: 'INSTALLED_BY_DEFAULT' },
        },
      ],
    })
  )
  await writeFile(
    join(pluginDirectory, 'plugin.json'),
    JSON.stringify({ name: pluginName, version: '1.0.0' })
  )
  return { marketplacePath, pluginName }
}

export function createDesktopScenario({ resultDir, workspacePath }) {
  const model = createCloudConfigModelService()
  const logPath = join(resultDir, 'executor.log')
  const evidence = []
  let restartDesktopApp

  return {
    prepareApp: model.prepareApp,
    attachServer: model.attachServer,
    handleHttp: model.handleHttp,
    close: model.close,
    setRestartDesktopApp(restart) {
      restartDesktopApp = restart
    },
    diagnostics() {
      return { ...model.diagnostics(), evidence }
    },
    async verify(control) {
      // The auth-mode switch below controls which turn is active. Reply
      // predictions also open turns and have their own auth-mode checkpoint.
      const preferences = JSON.parse(
        await control.command('setAppPreferences', 'body', {
          value: JSON.stringify({ replyPredictionsEnabled: false }),
        })
      )
      assert.equal(preferences.replyPredictionsEnabled, false)

      const addresses = new Map()
      const rpc = (method, params, timeoutMs = DEFAULT_STEP_TIMEOUT_MS) =>
        requestExecutor(control, method, params, timeoutMs)
      const native = (method, params = {}) =>
        rpc('runtime.codex.app_server.request', { method, params }, RECOVERY_TIMEOUT_MS)
      const address = taskId => {
        assert.ok(addresses.has(taskId), `Missing native owner for ${taskId}`)
        return addresses.get(taskId)
      }
      const task = async taskId => (await rpc('runtime.tasks.get', { taskId })).task
      const transcript = taskId =>
        rpc('runtime.tasks.transcript', { address: address(taskId), refresh: true })
      const waitTask = (taskId, status = 'done') =>
        waitForValue(
          () => task(taskId),
          value => {
            if (status !== 'failed') assert.notEqual(value?.status, 'failed', JSON.stringify(value))
            return value?.status === status
          },
          `Task ${taskId} did not reach ${status}`,
          RECOVERY_TIMEOUT_MS
        )
      const executionRequest = (taskId, marker, { official = false, followup = false } = {}) => {
        const provider = official ? 'openai' : MODEL_PROVIDER_ID
        const modelId = official ? OFFICIAL_MODEL : DEFAULT_MODEL_ID
        return {
          task_id: taskId,
          subtask_id: `${taskId}-${followup ? 'followup' : 'initial'}`,
          prompt: marker,
          new_session: !followup,
          project_workspace_path: workspacePath,
          bot: [{ shell_type: 'Codex', name: 'Cloud configuration recovery' }],
          model_config: {
            model_id: modelId,
            model_provider: provider,
            ...(official ? { wework_model_kind: 'codex-official' } : {}),
          },
        }
      }
      const create = async (name, { official = false, goal = false } = {}) => {
        const marker = `${PREFIX}_${name}`
        const taskId = `cloud-config-${name.toLowerCase()}`
        const request = executionRequest(taskId, marker, { official })
        const result = await rpc('runtime.tasks.create', {
          taskId,
          title: marker,
          runtime: 'codex',
          workspacePath,
          message: marker,
          clientUserMessageId: `${taskId}-initial`,
          modelSelection: {
            modelName: request.model_config.model_id,
            modelType: 'runtime',
            options: { runnerModelProvider: request.model_config.model_provider },
          },
          ...(goal ? { initialGoal: { objective: marker, status: 'active' } } : {}),
          executionRequest: request,
        })
        assert.equal(result.accepted, true, JSON.stringify(result))
        addresses.set(taskId, { deviceId: result.deviceId, taskId, runtime: 'codex' })
        return taskId
      }
      const completed = async (taskId, marker, expectedRequests = 1) => {
        const persisted = await waitForValue(
          () => task(taskId),
          value => {
            assert.notEqual(value?.status, 'failed', JSON.stringify(value))
            return (
              value?.status === 'done' &&
              model.diagnostics().requests.filter(request => request.marker === marker).length >=
                expectedRequests
            )
          },
          `Task ${taskId} did not finish its real model response`,
          RECOVERY_TIMEOUT_MS
        )
        // Native history reads must not compete with the deliberately failing
        // resume/start request: another in-flight RPC correctly prevents restart.
        const history = await waitForValue(
          () => transcript(taskId),
          value =>
            value.turns.at(-1)?.status === 'done' &&
            value.running === false &&
            JSON.stringify(value.messages).includes(`${marker}_COMPLETE`),
          `Task ${taskId} did not persist its final recovery reply`,
          DEFAULT_STEP_TIMEOUT_MS
        )
        evidence.push({ taskId, status: persisted.status, threadId: persisted.threadId })
        return history
      }
      const restartWhenIdle = async () => {
        const result = await restartCodexWhenIdle(
          async () => JSON.parse(await control.command('restartLocalCodexAppServerIfIdle', 'body')),
          RECOVERY_TIMEOUT_MS
        )
        assert.equal(result.requiresConfirmation, false)
        assert.equal(result.activeTaskCount, 0)
        assert.equal(result.pendingRequestCount, 0)
        return result
      }
      const startFault = async () => {
        // A persisted reply can still own a native background prediction. Admit
        // the cold-process fixture only after that work has actually finished.
        const idleRestart = await restartWhenIdle()
        evidence.push({ beforeFault: true, idleRestart })
        const failureCount = await model.failBundle()
        const offset = (await readFile(logPath, 'utf8')).length
        const result = await rpc(
          'runtime.codex.app_server.restart',
          // Force the intentional fault-injection restart; background rate-limit
          // reads can be in flight and must not turn this setup step into a
          // confirmation path.
          { force: true },
          RECOVERY_TIMEOUT_MS
        )
        assert.equal(result.restarted, true, JSON.stringify(result))
        return { offset, failureCount }
      }
      const assertDegraded = async ({ offset, failureCount }, expected) => {
        const log = await waitForLogPattern(
          logPath,
          /codex auth degraded after cloud config failure/,
          { fromOffset: offset, timeoutMs: RECOVERY_TIMEOUT_MS }
        )
        assert.ok(model.diagnostics().bundleFailures > failureCount)
        const recoveryMethod = assertCloudConfigRecovery(log.slice(offset), expected)
        evidence.push({
          recoveryMethod,
          bundleFailures: model.diagnostics().bundleFailures,
        })
      }
      const restoreOfficial = async name => {
        model.recoverBundle()
        // A completed task can still have a native composer prediction or read
        // in flight. Reuse the idle-only restart gate before changing auth modes.
        const idleRestart = await restartWhenIdle()
        evidence.push({ officialRestore: name, idleRestart })
        const marker = `${PREFIX}_${name}`
        model.plan(marker)
        const taskId = await create(name, { official: true })
        await completed(taskId, marker)
        assert.equal(model.diagnostics().requests.at(-1)?.subscription, true)
        return taskId
      }

      await createSingleRootLocalProject(control, workspacePath, 'cloud-config-recovery')
      await control.command('ensureLocalModelCatalogReady', 'body', {
        timeoutMs: RECOVERY_TIMEOUT_MS,
      })

      // The same native thread must survive a genuine configuration-service failure.
      model.plan(`${PREFIX}_OLD`)
      const oldTask = await create('OLD')
      const original = await completed(oldTask, `${PREFIX}_OLD`)
      const oldThread = (await task(oldTask)).threadId
      const authenticatedSetup = model.diagnostics()
      assert.ok(authenticatedSetup.bundleSuccesses > 0, JSON.stringify(authenticatedSetup))
      const resumeFault = await startFault()
      model.plan(`${PREFIX}_FOLLOWUP`)
      const sent = await rpc('runtime.tasks.send', {
        address: address(oldTask),
        message: `${PREFIX}_FOLLOWUP`,
        clientUserMessageId: 'cloud-config-old-followup',
        executionRequest: executionRequest(oldTask, `${PREFIX}_FOLLOWUP`, { followup: true }),
      })
      assert.equal(sent.accepted, true, JSON.stringify(sent))
      const continued = await completed(oldTask, `${PREFIX}_FOLLOWUP`)
      await assertDegraded(resumeFault, {
        methods: ['thread/resume', 'plugin/installed'],
        taskId: oldTask,
        threadId: oldThread,
      })
      assert.equal((await task(oldTask)).threadId, oldThread)
      assert.ok(continued.turns.length > original.turns.length)
      assert.ok(JSON.stringify(continued.messages).includes(`${PREFIX}_OLD_COMPLETE`))

      // A real bundled-plugin change must restart the idle process without
      // restoring the subscription auth whose cloud configuration is still down.
      const pluginSync = await rpc(
        'runtime.codex.plugin.sync_bundled',
        await preparePluginSyncFixture(resultDir)
      )
      assert.deepEqual(pluginSync, { status: 'ready', updated: true })
      evidence.push({ pluginSync })

      model.plan(`${PREFIX}_NEW_OFFLINE`)
      const offlineTask = await create('NEW_OFFLINE')
      await completed(offlineTask, `${PREFIX}_NEW_OFFLINE`)
      assert.notEqual((await task(offlineTask)).threadId, oldThread)
      const config = await native('config/read', { includeLayers: true, cwd: null })
      assert.ok(config.config)
      assert.ok((await rpc('runtime.codex.models.list', { includeHidden: true })).data.length > 0)

      // An active router turn must never admit an official request without auth.
      const held = model.plan(`${PREFIX}_HELD_CLOUD`, [{ hold: true }])
      const heldTask = await create('HELD_CLOUD')
      await waitForValue(
        () => held.count,
        value => value === 1,
        'Cloud turn was not held',
        DEFAULT_STEP_TIMEOUT_MS
      )
      const officialBefore = model.diagnostics().requests.filter(value => value.subscription).length
      model.recoverBundle()
      const rejectionOffset = (await readFile(logPath, 'utf8')).length
      const protectedTask = await create('OFFICIAL_BUSY', { official: true })
      await waitTask(protectedTask, 'failed')
      const rejected = await transcript(protectedTask)
      assert.equal(rejected.running, false)
      assert.equal(rejected.threadId, null)
      assert.deepEqual(rejected.turns, [])
      // Prelaunch failures are published by the Runtime and have no native history.
      await waitForLogPattern(
        logPath,
        new RegExp(
          `runtime work turn failed[^\\n]*local_task_id=${protectedTask} error="Codex authentication mode is busy \\(current=WeworkRouter, requested=LocalSubscription, active_turns=1, pending_requests=\\d+\\); retry after active turns and requests finish"`
        ),
        { fromOffset: rejectionOffset, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      await waitForLogPattern(
        logPath,
        new RegExp(
          `runtime terminal response event emitted event=response\\.failed local_task_id=${protectedTask} [^\\n]*delivered_receivers=[1-9]\\d* delivery=broadcast`
        ),
        { fromOffset: rejectionOffset, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
      )
      assert.equal(
        model.diagnostics().requests.filter(value => value.subscription).length,
        officialBefore
      )
      assert.equal((await task(heldTask)).status, 'running')
      held.rounds[0].release()
      await completed(heldTask, `${PREFIX}_HELD_CLOUD`)
      await restoreOfficial('OFFICIAL_RESTORED')

      // Exercise the primary config/read and thread/start recovery entry points.
      const configFault = await startFault()
      assert.ok((await native('config/read', { includeLayers: true, cwd: null })).config)
      await assertDegraded(configFault, { methods: ['config/read', 'plugin/installed'] })
      assert.ok((await rpc('runtime.codex.models.list', { includeHidden: true })).data.length > 0)
      await restoreOfficial('OFFICIAL_BEFORE_START')
      const startFaultState = await startFault()
      model.plan(`${PREFIX}_NEW_RECOVERED`)
      const newTask = await create('NEW_RECOVERED')
      await completed(newTask, `${PREFIX}_NEW_RECOVERED`)
      await assertDegraded(startFaultState, { methods: ['thread/start', 'plugin/installed'] })

      await restoreOfficial('OFFICIAL_BEFORE_GOAL')
      const goalMarker = `${PREFIX}_GOAL`
      let goalTask
      const goalPlan = model.plan(goalMarker, [
        { text: `${goalMarker}_INITIAL` },
        { hold: true },
        {
          beforeComplete: async () => {
            const result = await rpc('runtime.tasks.goal.set', {
              address: address(goalTask),
              status: 'complete',
            })
            assert.equal(result.goal.status, 'complete')
          },
        },
      ])
      goalTask = await create('GOAL', { goal: true })
      await waitForValue(
        () => goalPlan.count,
        value => value === 2,
        'The real Goal did not continue before restart',
        RECOVERY_TIMEOUT_MS
      )
      const beforeGoal = (await rpc('runtime.tasks.goal.get', { address: address(goalTask) })).goal
      assert.equal(beforeGoal.status, 'active')
      const goalThread = (await task(goalTask)).threadId
      assert.equal(typeof goalThread, 'string')
      const goalFailureCount = await model.failBundle()
      const goalOffset = (await readFile(logPath, 'utf8')).length
      assert.equal(typeof restartDesktopApp, 'function')
      await restartDesktopApp({ forceStop: true })
      await completed(goalTask, goalMarker, 3)
      assert.equal(goalPlan.count, 3, 'Goal recovery started a duplicate model turn')
      const afterGoal = (await rpc('runtime.tasks.goal.get', { address: address(goalTask) })).goal
      assert.equal(afterGoal.status, 'complete')
      assert.equal(afterGoal.objective, beforeGoal.objective)
      assert.equal(afterGoal.createdAt, beforeGoal.createdAt)
      assert.equal((await task(goalTask)).threadId, goalThread)
      // Startup config reads may recover auth before the persisted Goal resumes.
      // Require both real degradation and the Goal's exact native thread recovery.
      await assertDegraded(
        { offset: goalOffset, failureCount: goalFailureCount },
        { taskId: goalTask, threadId: goalThread }
      )

      // A second complete desktop restart must reconstruct the final reply and
      // stopped Goal from disk without starting another model continuation.
      const openGoalConversation = async () => {
        await control.command('waitFor', `[data-testid="runtime-local-task-row-${goalTask}"]`)
        await control.command('click', `[data-testid="runtime-local-task-row-${goalTask}"]`)
        await control.command('waitFor', ACTIVE_WORKBENCH_SELECTOR, {
          text: `${goalMarker}_COMPLETE`,
        })
      }
      await openGoalConversation()
      model.recoverBundle()
      await restartDesktopApp()
      await completed(goalTask, goalMarker, 3)
      assert.equal(goalPlan.count, 3, 'The completed Goal continued after a cold desktop restart')
      // Main-window startup restores configured fixed tabs, not the last transient task route.
      await openGoalConversation()
      assert.equal(goalPlan.count, 3, 'Reopening the completed Goal started another model turn')
      assert.equal(
        (await rpc('runtime.tasks.goal.get', { address: address(goalTask) })).goal.status,
        'complete'
      )
      const lifecycle = JSON.parse(
        await control.command('getRuntimeLifecycleState', 'body', {
          value: JSON.stringify(address(goalTask)),
        })
      )
      assert.equal(lifecycle.derived.isBusy, false)
      assert.equal(lifecycle.derived.canSend, true)
    },
  }
}
