import {
  assertCloudAttachmentProjectSelection,
  assertRuntimeTaskAttachments,
  findOwnedRuntimeProject,
  findOwnedRuntimeTask,
} from './workspace-attachment-evidence.mjs'
import {
  ATTACHMENT_ONLY_FILENAME,
  CLOUD_DEVICE_ID,
  COMPOSER_READY_STABILITY_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  IMAGE_ARTIFACT_BASE64,
  WORKBENCH_READY_TIMEOUT_MS,
  assert,
  join,
  mkdir,
  resultDir,
  selectE2EModel,
  withTimeout,
  writeFile,
} from './shared.mjs'

export function createCloudAttachmentVerification({
  cloudEnvironment,
  composerSelector,
  control,
  projectRowSelector,
  projectUiId,
  workspacePath,
}) {
  let projectSourceKey = null
  return {
    prepareConversation: async () => {
      const { projectWork, workspace } = findOwnedRuntimeProject(
        await readBeforeDeadline(
          () => cloudEnvironment.runtimeWork(),
          Date.now() + DEFAULT_STEP_TIMEOUT_MS,
          `The owning cloud project did not respond within ${DEFAULT_STEP_TIMEOUT_MS}ms`
        ),
        CLOUD_DEVICE_ID,
        workspacePath
      )
      assert.equal(workspace.available, true, 'The owning cloud project is unavailable')
      if (projectSourceKey) {
        assert.equal(projectWork.project.key, projectSourceKey, 'The cloud project source changed')
      }
      projectSourceKey = projectWork.project.key
      await prepareCloudAttachmentConversation(control, composerSelector, projectRowSelector, {
        projectUiId,
        deviceId: CLOUD_DEVICE_ID,
        workspacePath,
      })
    },
    verifySubmittedTask: () => readCloudAttachmentTask(control, cloudEnvironment, workspacePath),
    verifyTaskAttachments: async tasks => {
      const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
      const message = `The cloud attachment verification did not finish within ${DEFAULT_STEP_TIMEOUT_MS}ms`
      assert.equal(tasks.length, 2, 'The cloud attachment flow did not verify two task identities')
      const root = cloudEnvironment.runtimeWorkspaceRoot
      const paths = await readBeforeDeadline(
        () =>
          assertRuntimeTaskAttachments({
            root,
            taskIds: tasks.map(task => task.taskId),
            filename: ATTACHMENT_ONLY_FILENAME,
            expectedBytes: Buffer.from(IMAGE_ARTIFACT_BASE64, 'base64'),
          }),
        deadline,
        message
      )
      await readBeforeDeadline(
        () =>
          writeFile(
            join(resultDir, 'cloud-attachment-evidence.json'),
            `${JSON.stringify({ projectSourceKey, root, tasks, paths }, null, 2)}\n`
          ),
        deadline,
        message
      )
    },
  }
}

async function prepareCloudAttachmentConversation(
  control,
  composerSelector,
  projectRowSelector,
  expectedSelection
) {
  await control.command(
    'clickWhenEnabled',
    `${projectRowSelector} [data-testid="project-new-conversation-button"]`
  )
  await control.command('waitFor', composerSelector, {
    stableMs: COMPOSER_READY_STABILITY_MS,
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  await selectE2EModel(control)
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  const message = `The attachment composer did not select its owning cloud project within ${DEFAULT_STEP_TIMEOUT_MS}ms`
  let selectionError
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(
      await readBeforeDeadline(
        () => control.command('getWorkbenchDebugSnapshot', 'body'),
        deadline,
        message
      )
    )
    try {
      assertCloudAttachmentProjectSelection(snapshot.workbench, expectedSelection)
      return
    } catch (error) {
      selectionError = error
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  }
  throw new Error(message, {
    cause: selectionError,
  })
}

async function readCloudAttachmentTask(control, cloudEnvironment, workspacePath) {
  const deadline = Date.now() + DEFAULT_STEP_TIMEOUT_MS
  const message = `The owning cloud runtime did not expose its attachment task within ${DEFAULT_STEP_TIMEOUT_MS}ms`
  let taskId
  while (Date.now() < deadline) {
    const snapshot = JSON.parse(
      await readBeforeDeadline(
        () => control.command('getWorkbenchDebugSnapshot', 'body'),
        deadline,
        message
      )
    )
    const address = snapshot.pane?.currentRuntimeTask ?? snapshot.workbench?.currentRuntimeTask
    assert.equal(address?.deviceId, CLOUD_DEVICE_ID, 'The attachment task used the wrong device')
    assert.ok(address.taskId, 'The attachment task did not expose its actual task ID')
    taskId ??= address.taskId
    assert.equal(
      address.taskId,
      taskId,
      'The UI attachment task changed during workspace resolution'
    )
    const evidence = findOwnedRuntimeTask(
      await readBeforeDeadline(() => cloudEnvironment.runtimeWork(), deadline, message),
      CLOUD_DEVICE_ID,
      address.taskId
    )
    if (evidence) {
      assert.ok(evidence.task.workspacePath, 'The owning cloud task did not expose its workspace')
    }
    if (evidence && address.workspacePath) {
      assert.equal(
        evidence.task.workspacePath,
        address.workspacePath,
        'The UI attachment task workspace differs from its owning cloud runtime'
      )
      assert.equal(
        evidence.task.workspacePath,
        workspacePath,
        'The attachment task did not execute in the selected cloud project'
      )
      return {
        deviceId: evidence.workspace.deviceId,
        taskId: evidence.task.taskId,
        workspacePath: evidence.task.workspacePath,
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())))
  }
  throw new Error(`${message}: ${taskId}`)
}

async function readBeforeDeadline(read, deadline, message) {
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) throw new Error(message)
  const result = await withTimeout(read(), remainingMs, message)
  if (Date.now() >= deadline) throw new Error(message)
  return result
}

export async function verifyCloudWorkspacePathMentions(
  { composerSelector, control, workspacePath },
  prepareConversation
) {
  const folderName = 'cloud-context-folder'
  const folderPath = join(workspacePath, folderName)
  await mkdir(folderPath, { recursive: true })
  await writeFile(join(folderPath, 'nested.txt'), 'cloud workspace path context\n')

  await control.command('click', '[data-testid="new-chat-button"]')
  await control.command('waitFor', composerSelector, { timeoutMs: WORKBENCH_READY_TIMEOUT_MS })
  await prepareConversation?.()
  await control.command('fill', composerSelector, { value: `@${folderName}` })
  await control.command('clickElementWithText', '[data-testid^="workspace-mention-option-"]', {
    text: folderName,
  })
  const folderChipSelector = `[data-testid="composer-path-chip-${folderName}"]`
  await control.command('waitFor', folderChipSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', folderChipSelector, {
      value: 'data-composer-path-kind',
    }),
    'folder',
    'The cloud workspace folder mention was not rendered as a folder reference'
  )

  await control.command('fill', composerSelector, { value: '@auth' })
  await control.command('clickElementWithText', '[data-testid^="workspace-mention-option-"]', {
    text: 'auth.ts',
  })
  const fileChipSelector = '[data-testid="composer-path-chip-auth-ts"]'
  await control.command('waitFor', fileChipSelector, {
    timeoutMs: DEFAULT_STEP_TIMEOUT_MS,
  })
  assert.equal(
    await control.command('getAttribute', fileChipSelector, {
      value: 'data-composer-path-kind',
    }),
    'file',
    'The cloud workspace file mention was not rendered as a file reference'
  )
}
