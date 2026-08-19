import { openBottomWorkspaceTerminal } from './conversation-layout.mjs'
import { sendPrompt } from './conversation-navigation.mjs'

import {
  ACTIVE_COMPOSER_SELECTOR,
  CHECKPOINT_TASK_COMPLETION_TEXT,
  CHECKPOINT_TASK_PROMPT,
  CLOUD_DEVICE_ID,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_LABEL,
  DEFAULT_STEP_TIMEOUT_MS,
  REMOTE_DOCKER_DEVICE_ID,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  commandOutput,
  dirname,
  join,
  pathExists,
  readFile,
  resultDir,
  runChecked,
  selectE2EModel,
  writeFile,
} from './shared.mjs'

const WORKTREE_CHECKPOINTS = [
  'cloud-worktree-capability',
  'cloud-worktree-create',
  'cloud-worktree-queued-cancel',
  'cloud-worktree-tools',
  'cloud-worktree-archive-restore',
  'cloud-worktree-device-restart',
]

const ACTIVE_WORKBENCH_SELECTOR =
  '[data-testid="desktop-workbench-main"][data-active-workbench-pane="true"]'
const WORKTREE_QUEUE_SCENARIO = 'worktree_queue_hold'
const WORKTREE_RESTART_SCENARIO = 'worktree_restart_hold'
const WORKTREE_QUEUE_PROMPT = 'WEWORK_DESKTOP_E2E_WORKTREE_QUEUE_HOLD'
const WORKTREE_RESTART_PROMPT = 'WEWORK_DESKTOP_E2E_WORKTREE_RESTART_HOLD'

function scenarioRequestCount(control, scenario) {
  return control.scenarioRequests.get(scenario)?.length ?? 0
}

async function waitForCondition(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error(message)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function runtimeWorkPath(name) {
  return join(resultDir, 'cloud-executor-home', 'runtime-work', name)
}

async function waitForNewTaskRow(control, knownRows, message) {
  return waitForCondition(
    async () => {
      const snapshot = JSON.parse(await control.command('snapshot', 'body'))
      const row = snapshot.testIds.find(
        testId => testId.startsWith('runtime-local-task-row-') && !knownRows.has(testId)
      )
      return row || null
    },
    WORKBENCH_READY_TIMEOUT_MS,
    message
  )
}

async function waitForCurrentTask(control, taskId, message) {
  return waitForCondition(
    async () => {
      const snapshot = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = snapshot.workbench?.currentRuntimeTask
      return task?.taskId === taskId && task.workspacePath ? task : null
    },
    WORKBENCH_READY_TIMEOUT_MS,
    message
  )
}

async function waitForPathState(path, exists, message) {
  await waitForCondition(
    async () => (await pathExists(path)) === exists,
    WORKBENCH_READY_TIMEOUT_MS,
    message
  )
}

async function openProjectComposer(context) {
  if (context.initialComposerAvailable) {
    context.initialComposerAvailable = false
  } else {
    await context.control.command('navigate', 'body', { value: '/' })
    await context.control.command('waitFor', context.projectRowSelector, {
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await context.control.command(
      'clickWhenEnabled',
      `${context.projectRowSelector} [data-testid="project-new-conversation-button"]`
    )
  }
  await context.control.command('waitFor', context.composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await selectE2EModel(context.control, DEFAULT_MODEL_ID, DEFAULT_MODEL_LABEL)
}

async function selectExecutionMode(control, mode, ref = null) {
  await control.command('click', '[data-testid="execution-mode-button"]')
  await control.command(
    'click',
    mode === 'git_worktree'
      ? '[data-testid="execution-mode-git-worktree-button"]'
      : '[data-testid="execution-mode-current-workspace-button"]'
  )
  await control.command('waitFor', '[data-testid="execution-mode-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  if (mode !== 'git_worktree') return

  assert.match(
    await control.command('getText', '[data-testid="execution-mode-button"]'),
    /新工作树|New worktree/,
    'The cloud composer did not switch to Worktree launch mode'
  )
  if (!ref) return

  await control.command('waitFor', '[data-testid="project-worktree-branch-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="project-worktree-branch-button"]')
  await control.command('waitFor', '[data-testid="project-worktree-branch-menu"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="project-worktree-branch-search-input"]', {
    value: ref,
  })
  await control.command('waitFor', '[data-testid="project-worktree-branch-option"]', {
    text: ref,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  const anchor = `worktree-branch-${ref.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  await control.command('markElementWithText', '[data-testid="project-worktree-branch-option"]', {
    text: ref,
    value: anchor,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', `[data-e2e-anchor-id="${anchor}"]`)
  assert.match(
    await control.command('getText', '[data-testid="project-worktree-branch-button"]'),
    new RegExp(ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'The selected Worktree starting ref was not retained by the composer'
  )
}

async function launchTask(
  context,
  {
    mode = 'git_worktree',
    prompt = CHECKPOINT_TASK_PROMPT,
    ref = null,
    scenario = 'checkpoint_task',
    waitForModel = true,
    waitForCompletion = true,
  } = {}
) {
  await openProjectComposer(context)
  await selectExecutionMode(context.control, mode, ref)
  const before = JSON.parse(await context.control.command('snapshot', 'body'))
  const knownRows = new Set(
    before.testIds.filter(testId => testId.startsWith('runtime-local-task-row-'))
  )
  const requestCount = scenarioRequestCount(context.control, scenario)
  context.control.setScenario(scenario)
  await sendPrompt(context.control, context.composerSelector, prompt)
  if (mode === 'git_worktree') {
    await context.control.command('waitFor', '[data-testid="worktree-creation-status"]', {
      timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
    })
  }
  const rowTestId = await waitForNewTaskRow(
    context.control,
    knownRows,
    `The ${mode} cloud task was not added to the runtime task list`
  )
  const taskId = rowTestId.replace('runtime-local-task-row-', '')
  if (waitForModel) {
    await context.control.awaitScenarioRequestCount(
      scenario,
      requestCount + 1,
      WORKBENCH_READY_TIMEOUT_MS
    )
  }
  if (waitForCompletion) {
    const completion =
      scenario === 'checkpoint_task'
        ? CHECKPOINT_TASK_COMPLETION_TEXT
        : `${scenario.toUpperCase()}_COMPLETE`
    await context.control.command('waitFor', '[data-testid="message-assistant"]', {
      text: completion,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
  }
  const task = await waitForCurrentTask(
    context.control,
    taskId,
    'The active workbench did not expose the newly created cloud task'
  )
  assert.equal(task.deviceId, CLOUD_DEVICE_ID, 'The Worktree task used the wrong device')
  assert.ok(task.workspacePath, 'The Worktree task did not expose a workspace path')
  return { ...task, rowTestId }
}

async function assertWorktreeCreated(task, sourcePath) {
  assert.notEqual(task.workspacePath, sourcePath, 'The task fell back to the base workspace')
  assert.equal(
    await pathExists(task.workspacePath),
    true,
    'The cloud Executor did not create the managed Worktree'
  )
}

async function archiveTask(control, task, { expectWorktreeRemoval = true } = {}) {
  const rowSelector = `[data-testid="${task.rowTestId}"]`
  await control.command('hover', rowSelector)
  await control.command('click', `[data-testid="runtime-local-task-archive-${task.taskId}"]`)
  await control.command(
    'waitFor',
    `[data-testid="runtime-local-task-archive-toast-${task.taskId}"]`,
    { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
  )
  if (!expectWorktreeRemoval) return
  await waitForPathState(
    task.workspacePath,
    false,
    `Archiving ${task.taskId} left its managed Worktree directory`
  )
  await waitForPathState(
    dirname(task.workspacePath),
    false,
    `Archiving ${task.taskId} left its managed Worktree container`
  )
}

async function deleteWorktreeFromSettings(control, task) {
  await control.command('navigate', 'body', { value: '/settings/worktrees' })
  await control.command('waitFor', '[data-testid="worktrees-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const deviceSelect = '[data-testid="worktrees-device-select"]'
  if (Number(await control.command('getElementCount', deviceSelect)) > 0) {
    await control.command('select', deviceSelect, { value: task.deviceId })
  }
  const deleteSelector = `[data-testid="delete-worktree-button-${task.taskId}"]`
  await control.command('waitFor', deleteSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', deleteSelector)
  await waitForCondition(
    async () =>
      Number(await control.command('getElementCount', deleteSelector).catch(() => '0')) === 0,
    WORKBENCH_READY_TIMEOUT_MS,
    `Deleting ${task.taskId} did not remove it from Worktree settings`
  )
  await waitForPathState(
    task.workspacePath,
    false,
    `Deleting ${task.taskId} left its Worktree path`
  )
}

async function cleanupCompletedWorktree(control, task) {
  await deleteWorktreeFromSettings(control, task)
}

async function setRuntimeConcurrency(context, value) {
  const settings = await context.cloudEnvironment.updateRuntimeSettings(value)
  assert.equal(
    settings.max_concurrent_tasks,
    value,
    `The cloud Runtime concurrency setting did not update to ${value}`
  )
}

async function verifyCapability(context) {
  const { cloudEnvironment, workspacePath } = context
  const initialWorktreeRoot = join(resultDir, 'cloud-executor-home', 'workspace', 'worktrees')
  const rootExistedBeforeProbe = await pathExists(initialWorktreeRoot)
  const ref = commandOutput('git', ['branch', '--show-current'], { cwd: workspacePath })
  const capabilities = await cloudEnvironment.worktreeCapabilities()
  assert.equal(capabilities.success, true, 'The capability RPC did not succeed')
  assert.equal(capabilities.deviceId, CLOUD_DEVICE_ID, 'Capability RPC reached the wrong device')
  assert.deepEqual(
    capabilities.runtimeWorktrees,
    {
      version: 1,
      managed: true,
      deferredPrepare: true,
      snapshots: true,
      restore: true,
      preflight: true,
      reconcile: true,
      persistentStorageVerified: true,
    },
    'The cloud Executor Worktree capability contract drifted'
  )

  const preflight = await cloudEnvironment.worktreePreflight(workspacePath, ref)
  assert.equal(preflight.success, true, 'The Worktree preflight RPC did not succeed')
  assert.equal(preflight.deviceId, CLOUD_DEVICE_ID, 'Preflight RPC reached the wrong device')
  assert.equal(preflight.sourcePath, workspacePath, 'Preflight changed the source path')
  assert.equal(preflight.supported, true, 'Preflight reported Worktree unsupported')
  assert.equal(preflight.gitRepository, true, 'Preflight did not identify the Git repository')
  assert.equal(preflight.gitCommonDirValid, true, 'Preflight rejected the Git common directory')
  assert.equal(
    preflight.gitCommonDirWritable,
    true,
    'Preflight reported a read-only Git common directory'
  )
  assert.equal(preflight.refValid, true, 'Preflight rejected the selected Git ref')
  assert.equal(preflight.writable, true, 'Preflight reported an unwritable Worktree root')
  assert.equal(preflight.errorCode, null, 'Preflight returned an unexpected error code')
  assert.equal(preflight.repoRoot, workspacePath, 'Preflight resolved the wrong repository root')
  assert.match(
    preflight.repoRootFingerprint,
    /^sha256:/,
    'Preflight omitted the repository identity fingerprint'
  )
  assert.ok(
    preflight.resolvedWorktreeRoot.startsWith(join(resultDir, 'cloud-executor-home')),
    'Preflight resolved the managed root outside the cloud Executor home'
  )
  if (!rootExistedBeforeProbe) {
    assert.equal(
      await pathExists(initialWorktreeRoot),
      false,
      'Capability/preflight probing created the managed Worktree root'
    )
  }

  const remoteCapabilities = await cloudEnvironment.worktreeCapabilities(REMOTE_DOCKER_DEVICE_ID)
  assert.equal(
    remoteCapabilities.runtimeWorktrees?.managed,
    true,
    'The Remote Docker route did not expose managed Worktree capability'
  )
  assert.equal(
    remoteCapabilities.runtimeWorktrees?.persistentStorageVerified,
    true,
    'The Remote Docker route did not verify persistent Worktree storage'
  )
  const remotePreflight = await cloudEnvironment.worktreePreflight(
    workspacePath,
    ref,
    REMOTE_DOCKER_DEVICE_ID
  )
  assert.equal(
    remotePreflight.refValid,
    true,
    'The Remote Docker route did not complete a real ref preflight'
  )

  const log = await readFile(cloudEnvironment.remoteExecutorLogPath, 'utf8')
  assert.match(
    log,
    /runtime:rpc received method=runtime\.worktrees\.capabilities/,
    'The capability assertion did not cross the real Backend-to-Executor RPC route'
  )
  assert.match(
    log,
    /runtime:rpc received method=runtime\.worktrees\.preflight/,
    'The preflight assertion did not cross the real Backend-to-Executor RPC route'
  )
}

async function createStartingRef(workspacePath) {
  const originalBranch = commandOutput('git', ['branch', '--show-current'], {
    cwd: workspacePath,
  })
  const branch = `e2e-worktree-ref-${process.pid}`
  await runChecked('git', ['checkout', '-b', branch], { cwd: workspacePath })
  await writeFile(join(workspacePath, 'worktree-ref-marker.txt'), `selected ref ${branch}\n`)
  await runChecked('git', ['add', 'worktree-ref-marker.txt'], { cwd: workspacePath })
  await runChecked('git', ['commit', '-m', 'test: add worktree starting ref marker'], {
    cwd: workspacePath,
  })
  const commit = commandOutput('git', ['rev-parse', 'HEAD'], { cwd: workspacePath })
  await runChecked('git', ['checkout', originalBranch], { cwd: workspacePath })
  return { branch, commit }
}

async function verifyCreate(context) {
  const startingRef = await createStartingRef(context.workspacePath)
  const first = await launchTask(context, {
    prompt: `${CHECKPOINT_TASK_PROMPT} create-isolation-a`,
    ref: startingRef.branch,
  })
  await assertWorktreeCreated(first, context.workspacePath)
  assert.equal(
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: first.workspacePath }),
    startingRef.commit,
    'The first Worktree did not start from the selected ref'
  )
  assert.equal(
    await pathExists(join(first.workspacePath, 'worktree-ref-marker.txt')),
    true,
    'The selected ref marker was missing from the first Worktree'
  )

  const second = await launchTask(context, {
    prompt: `${CHECKPOINT_TASK_PROMPT} create-isolation-b`,
    ref: startingRef.branch,
  })
  await assertWorktreeCreated(second, context.workspacePath)
  assert.notEqual(
    first.workspacePath,
    second.workspacePath,
    'Two cloud Worktree tasks shared the same final path'
  )
  assert.equal(
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: second.workspacePath }),
    startingRef.commit,
    'The second Worktree did not start from the selected ref'
  )

  await writeFile(join(first.workspacePath, 'isolation-a.txt'), 'first worktree only\n')
  await writeFile(join(second.workspacePath, 'isolation-b.txt'), 'second worktree only\n')
  assert.equal(
    await pathExists(join(first.workspacePath, 'isolation-b.txt')),
    false,
    'The second Worktree content leaked into the first Worktree'
  )
  assert.equal(
    await pathExists(join(second.workspacePath, 'isolation-a.txt')),
    false,
    'The first Worktree content leaked into the second Worktree'
  )

  const runtimeLog = await readFile(context.cloudEnvironment.remoteExecutorRuntimeLogPath, 'utf8')
  for (const task of [first, second]) {
    assert.ok(
      runtimeLog.includes(`cwd=${task.workspacePath}`),
      `The runtime did not start from the final Worktree path for ${task.taskId}`
    )
  }

  await deleteWorktreeFromSettings(context.control, first)
  await deleteWorktreeFromSettings(context.control, second)
}

async function verifyQueuedCancel(context) {
  const previousConcurrency = (await context.cloudEnvironment.runtimeSettings())
    .max_concurrent_tasks
  await setRuntimeConcurrency(context, 1)
  context.control.holdScenarioResponse(WORKTREE_QUEUE_SCENARIO)
  try {
    const first = await launchTask(context, {
      mode: 'current_workspace',
      prompt: WORKTREE_QUEUE_PROMPT,
      scenario: WORKTREE_QUEUE_SCENARIO,
      waitForCompletion: false,
    })
    await context.control.command(
      'waitFor',
      `[data-testid="runtime-local-task-running-${first.taskId}"]`,
      { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )

    const queuedModelRequestsBefore = scenarioRequestCount(context.control, 'checkpoint_task')
    const queued = await launchTask(context, {
      prompt: `${CHECKPOINT_TASK_PROMPT} queued-worktree-cancel`,
      waitForModel: false,
      waitForCompletion: false,
    })
    await context.control.command(
      'waitFor',
      `[data-testid="runtime-local-task-queued-${queued.taskId}"]`,
      { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    assert.notEqual(
      queued.workspacePath,
      context.workspacePath,
      'The queued Worktree task planned the base workspace path'
    )
    assert.equal(
      await pathExists(queued.workspacePath),
      false,
      'The queued task created its Worktree before a runtime slot was available'
    )
    assert.equal(
      await pathExists(dirname(queued.workspacePath)),
      false,
      'The queued task created its Worktree container before a runtime slot was available'
    )
    assert.equal(
      scenarioRequestCount(context.control, 'checkpoint_task'),
      queuedModelRequestsBefore,
      'The queued Worktree reached the model before acquiring a runtime slot'
    )

    await archiveTask(context.control, queued, { expectWorktreeRemoval: false })
    await waitForCondition(
      async () => {
        const index = await readJson(runtimeWorkPath('index.json'))
        return index.tasks?.[queued.taskId]?.archived === true
      },
      WORKBENCH_READY_TIMEOUT_MS,
      'The queued Worktree task was not archived after cancellation'
    )
    assert.equal(
      await pathExists(queued.workspacePath),
      false,
      'Cancelling the queued task created its planned Worktree path'
    )
    assert.equal(
      await pathExists(dirname(queued.workspacePath)),
      false,
      'Cancelling the queued task left a Worktree container'
    )
    assert.equal(
      scenarioRequestCount(context.control, 'checkpoint_task'),
      queuedModelRequestsBefore,
      'The cancelled queued Worktree reached the model'
    )

    context.control.releaseScenarioResponse(WORKTREE_QUEUE_SCENARIO)
    await context.control.command('click', `[data-testid="${first.rowTestId}"]`)
    await context.control.command('waitFor', '[data-testid="message-assistant"]', {
      text: `${WORKTREE_QUEUE_SCENARIO.toUpperCase()}_COMPLETE`,
      timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
    })
    await archiveTask(context.control, first, { expectWorktreeRemoval: false })
    await waitForCondition(
      async () => {
        const index = await readJson(runtimeWorkPath('index.json'))
        return index.tasks?.[first.taskId]?.archived === true
      },
      WORKBENCH_READY_TIMEOUT_MS,
      'The queue blocker task did not finish archiving'
    )
  } finally {
    context.control.releaseScenarioResponse(WORKTREE_QUEUE_SCENARIO)
    await setRuntimeConcurrency(context, previousConcurrency)
  }
}

async function verifyFilePanel(control, task, markerName, markerText) {
  await control.command('click', '[data-testid="toggle-right-workspace-panel-button"]')
  const launcherSnapshot = JSON.parse(await control.command('snapshot', ACTIVE_WORKBENCH_SELECTOR))
  if (launcherSnapshot.testIds.includes('right-workspace-new-tab-button')) {
    await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
  }
  await control.command('waitFor', '[data-testid="right-workspace-file-option"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', '[data-testid="right-workspace-file-option"]')
  await control.command('waitFor', '[data-testid="workspace-file-tree"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('fill', '[data-testid="workspace-file-search-input"]', {
    value: markerName,
  })
  const fileSelector = `button[data-type="item"][aria-label="${markerName}"]`
  await control.command('waitFor', fileSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('click', fileSelector)
  await control.command('waitFor', '[data-testid="workspace-file-path"]', {
    text: join(task.workspacePath, markerName),
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="workspace-markdown-preview"]', {
    text: markerText,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
}

async function verifyGitPanel(control, markerName) {
  await control.command('click', '[data-testid="right-workspace-new-tab-button"]')
  await control.command('click', '[data-testid="right-workspace-review-option"]')
  await control.command('waitFor', '[data-testid="review-view-switcher-button"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="file-changes-review-file-tree"]', {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await control.command('waitFor', '[data-testid="file-changes-review-file-diff-toggle"]', {
    text: markerName,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.match(
    await control.command('getText', '[data-testid="file-changes-review-toolbar"]'),
    /\+\d+/,
    'The Git review panel did not expose the Worktree-only addition'
  )
}

async function verifyTools(context) {
  const task = await launchTask(context, {
    prompt: `${CHECKPOINT_TASK_PROMPT} worktree-tools`,
  })
  await assertWorktreeCreated(task, context.workspacePath)
  const markerName = 'worktree-tools.md'
  const markerText = `worktree tools ${task.taskId}`
  await writeFile(join(task.workspacePath, markerName), `# ${markerText}\n`)
  assert.equal(
    await pathExists(join(context.workspacePath, markerName)),
    false,
    'The Worktree-only tool marker leaked into the base workspace'
  )

  const sessionsBefore = new Set(
    context.cloudEnvironment.terminalSessionRecords().map(record => record.session_id)
  )
  await openBottomWorkspaceTerminal(context.control, 'The cloud Worktree task')
  const terminalRecord = await waitForCondition(
    async () =>
      context.cloudEnvironment
        .terminalSessionRecords()
        .find(
          record =>
            !sessionsBefore.has(record.session_id) &&
            record.device_id === CLOUD_DEVICE_ID &&
            record.path === task.workspacePath
        ) ?? null,
    WORKBENCH_READY_TIMEOUT_MS,
    'The terminal session did not use the final Worktree path'
  )
  assert.equal(terminalRecord.path, task.workspacePath)

  await verifyFilePanel(context.control, task, markerName, markerText)
  await verifyGitPanel(context.control, markerName)

  const ideSelector = '[data-testid="open-code-server-titlebar-button"]'
  await context.control.command('waitFor', ideSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await context.control.command('getAttribute', ideSelector, {
      value: 'data-workspace-path',
    }),
    task.workspacePath,
    'The IDE action did not target the final Worktree path'
  )
  assert.notEqual(
    await context.control.command('getAttribute', ideSelector, {
      value: 'disabled',
    }),
    'true',
    'The IDE action was disabled for the cloud Worktree task'
  )
  const backendLogBefore = await readFile(context.cloudEnvironment.backendLogPath, 'utf8')
  await context.control.command('click', ideSelector)
  await waitForCondition(
    async () => {
      const backendLog = await readFile(context.cloudEnvironment.backendLogPath, 'utf8')
      return (
        backendLog.length > backendLogBefore.length &&
        backendLog.includes(`/api/devices/${CLOUD_DEVICE_ID}/code-server`)
      )
    },
    WORKBENCH_READY_TIMEOUT_MS,
    'The IDE action did not reach the real cloud code-server endpoint'
  )
  assert.equal(
    Number(
      await context.control.command('getElementCount', '[data-testid="code-server-error-dialog"]')
    ),
    0,
    'The IDE action failed after targeting the Worktree task'
  )

  const runtimeLog = await readFile(context.cloudEnvironment.remoteExecutorRuntimeLogPath, 'utf8')
  assert.ok(
    runtimeLog.includes(`cwd=${task.workspacePath}`),
    'The runtime task did not use the final Worktree path'
  )
  await cleanupCompletedWorktree(context.control, task)
}

async function verifyArchiveRestore(context) {
  const task = await launchTask(context, {
    prompt: `${CHECKPOINT_TASK_PROMPT} archive-restore`,
  })
  await assertWorktreeCreated(task, context.workspacePath)
  const markerName = 'worktree-archive-marker.txt'
  const markerText = `restore ${task.taskId}\n`
  await writeFile(join(task.workspacePath, markerName), markerText)
  await archiveTask(context.control, task)

  const archivedState = await readJson(runtimeWorkPath('worktrees.json'))
  const archivedRecord = archivedState.records?.[task.workspacePath]
  assert.equal(archivedRecord?.state, 'restorable', 'Archiving did not persist restorable state')
  assert.match(
    archivedRecord?.snapshotRef ?? '',
    /^refs\/wegent\/worktree-snapshots\//,
    'Archiving did not persist a Worktree snapshot ref'
  )
  assert.match(
    archivedRecord?.snapshotCommit ?? '',
    /^[0-9a-f]{40}$/i,
    'Archiving did not persist a Worktree snapshot commit'
  )

  await context.control.command('navigate', 'body', {
    value: '/settings/archived-conversations',
  })
  await context.control.command('waitFor', '[data-testid="archived-conversations-settings-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  const suffix = `${task.deviceId}-${task.taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
  const unarchiveSelector = `[data-testid="archived-unarchive-button-${suffix}"]`
  await context.control.command('waitFor', unarchiveSelector, {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await context.control.command('clickWhenEnabled', unarchiveSelector)
  await context.control.command('waitFor', '[data-testid="archived-unarchive-success"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await waitForPathState(
    task.workspacePath,
    true,
    'Unarchiving did not restore the managed Worktree path'
  )
  assert.equal(
    await readFile(join(task.workspacePath, markerName), 'utf8'),
    markerText,
    'The restored Worktree lost its archived file content'
  )
  const restoredState = await readJson(runtimeWorkPath('worktrees.json'))
  assert.equal(
    restoredState.records?.[task.workspacePath]?.state,
    'active',
    'Restoring did not return the Worktree record to active state'
  )
  await deleteWorktreeFromSettings(context.control, task)
}

async function verifyDeviceRestart(context) {
  context.control.holdScenarioResponse(WORKTREE_RESTART_SCENARIO)
  let task
  try {
    task = await launchTask(context, {
      prompt: WORKTREE_RESTART_PROMPT,
      scenario: WORKTREE_RESTART_SCENARIO,
      waitForCompletion: false,
    })
    await assertWorktreeCreated(task, context.workspacePath)
    await context.control.command(
      'waitFor',
      `[data-testid="runtime-local-task-running-${task.taskId}"]`,
      { timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    const requestsBeforeRestart = scenarioRequestCount(context.control, WORKTREE_RESTART_SCENARIO)
    const restart = await context.cloudEnvironment.restartCloudExecutor()
    assert.equal(
      restart.runtimeInstanceId,
      restart.previousInstanceId,
      'The same Executor home did not preserve its stable runtime identity'
    )

    const reconciledLog = await waitForCondition(
      async () => {
        const log = await readFile(context.cloudEnvironment.remoteExecutorLogPath, 'utf8')
        const appended = log.slice(restart.logOffset)
        return appended.includes('interrupted worktree task reconciled without runtime restart')
          ? appended
          : null
      },
      WORKBENCH_READY_TIMEOUT_MS,
      'The restarted Executor did not log Worktree reconciliation'
    )
    await new Promise(resolvePromise => setTimeout(resolvePromise, 750))
    assert.equal(
      scenarioRequestCount(context.control, WORKTREE_RESTART_SCENARIO),
      requestsBeforeRestart,
      'Executor restart automatically resumed the interrupted model turn'
    )

    await waitForCondition(
      async () => {
        const current = await context.cloudEnvironment.runtimeTask(task.taskId)
        return current?.status === 'failed' && current.running === false ? current : null
      },
      WORKBENCH_READY_TIMEOUT_MS,
      'The reconciled task did not become failed and stopped'
    )
    const runtimeIndex = await readJson(runtimeWorkPath('index.json'))
    assert.match(
      runtimeIndex.tasks?.[task.taskId]?.runtime_handle?.lastError ?? '',
      /runtime was not resumed/i,
      'Reconcile did not persist the no-auto-resume diagnostic'
    )
    const worktrees = await readJson(runtimeWorkPath('worktrees.json'))
    assert.equal(
      worktrees.records?.[task.workspacePath]?.state,
      'active',
      'Reconcile did not keep the valid Worktree manageable'
    )
    assert.equal(
      await pathExists(task.workspacePath),
      true,
      'Reconcile removed the valid interrupted Worktree'
    )

    await deleteWorktreeFromSettings(context.control, task)
  } finally {
    context.control.releaseScenarioResponse(WORKTREE_RESTART_SCENARIO)
  }
}

async function verifyCloudWorktreeCheckpoint({
  checkpoint,
  cloudEnvironment,
  composerSelector,
  control,
  projectRowSelector,
  setPhase,
  workspacePath,
}) {
  const context = {
    cloudEnvironment,
    composerSelector: composerSelector ?? ACTIVE_COMPOSER_SELECTOR,
    control,
    initialComposerAvailable: true,
    projectRowSelector,
    workspacePath,
  }
  const checkpoints = checkpoint === 'cloud-git-worktree' ? WORKTREE_CHECKPOINTS : [checkpoint]
  for (const selected of checkpoints) {
    assert.ok(
      WORKTREE_CHECKPOINTS.includes(selected),
      `Unknown cloud Worktree checkpoint: ${selected}`
    )
    setPhase(selected)
    switch (selected) {
      case 'cloud-worktree-capability':
        await verifyCapability(context)
        break
      case 'cloud-worktree-create':
        await verifyCreate(context)
        break
      case 'cloud-worktree-queued-cancel':
        await verifyQueuedCancel(context)
        break
      case 'cloud-worktree-tools':
        await verifyTools(context)
        break
      case 'cloud-worktree-archive-restore':
        await verifyArchiveRestore(context)
        break
      case 'cloud-worktree-device-restart':
        await verifyDeviceRestart(context)
        break
    }
  }
}

export { WORKTREE_CHECKPOINTS, verifyCloudWorktreeCheckpoint }
