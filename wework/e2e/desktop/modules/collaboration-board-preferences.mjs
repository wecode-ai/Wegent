import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertProjectBoardGrouping,
  openProjectBoard,
  selectProjectBoardGrouping,
} from './collaboration-board-personal-view.mjs'
import {
  reloadMainWindow,
  waitForTestIdByText,
  waitForWorkbenchDebugState,
} from './workspace-flows.mjs'
import { createCollaborationBoardIssue } from './collaboration-board-issue.mjs'

const preferenceKey = (userId, store, projectId) =>
  `collaboration-board-group:v1:${userId}:${store}:${projectId}`
const taskContent = '[data-testid="workspace-tab-content-fixed-task"][aria-hidden="false"]'

async function assertPreference(control, userId, store, projectId, expected) {
  assert.equal(
    await control.command('getLocalStorageItem', 'body', {
      value: preferenceKey(userId, store, projectId),
    }),
    expected,
    `The ${store} Project preference was not isolated for user ${userId}`
  )
}

async function lastProjectStorageKey(control, user) {
  const connection = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.equal(connection.user.id, user.id, 'Project selection used the wrong cloud owner')
  assert.ok(connection.apiBaseUrl, 'The cloud owner must have a backend identity')
  return `wework.lastProjectId.${JSON.stringify([connection.apiBaseUrl, user.id])}`
}

async function assertProjectSelection(control, user, projectId, timeoutMs) {
  await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
  await waitForWorkbenchDebugState(
    control,
    ({ workbench }) =>
      workbench?.isBootstrapping === false &&
      workbench.runtimeWorkSummary.projectCount > 0 &&
      workbench.currentRuntimeTask === null &&
      (workbench.currentProject?.id ?? null) === projectId,
    `The workbench did not restore user ${user.id}'s last project selection`,
    timeoutMs
  )
  assert.equal(
    await control.command('getLocalStorageItem', 'body', {
      value: await lastProjectStorageKey(control, user),
    }),
    projectId === null ? 'none' : String(projectId),
    `The last project selection was not isolated for user ${user.id}`
  )
}

async function selectProjectForOwner(control, user, projectName, timeoutMs) {
  await control.command('clickWhenEnabled', '[data-testid="workspace-tab-select-fixed-task"]')
  await control.command('clickWhenEnabled', `${taskContent} [data-testid="new-chat-button"]`)
  await control.command(
    'clickWhenEnabled',
    `${taskContent} [data-testid="desktop-workbench-main"] [data-testid="project-work-button"]`
  )
  const option =
    projectName === null
      ? 'no-project-option'
      : await waitForTestIdByText(
          control,
          '[data-testid="project-work-menu"]',
          'project-option-',
          projectName,
          timeoutMs
        )
  if (projectName !== null) assert.match(option, /^project-option-\d+$/)
  await control.command(
    'clickWhenEnabled',
    `[data-testid="project-work-menu"] button[data-testid="${option}"]`
  )
  const projectId = projectName === null ? null : Number(option.slice('project-option-'.length))
  if (projectId !== null) assert.ok(Number.isInteger(projectId), 'The project option has no ID')
  await assertProjectSelection(control, user, projectId, timeoutMs)
  return projectId
}

async function switchAccount(control, restartDesktopApp, token, user) {
  await control.command('click', '[data-testid="settings-button"]')
  await control.command('waitFor', '[data-testid="logout-menu-button"]')
  await control.command('click', '[data-testid="logout-menu-button"]')
  assert.equal(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' }),
    '',
    'Logging out did not clear the previous cloud connection'
  )
  // Bootstrap authenticates this real backend token with /users/me before mounting the workbench.
  await restartDesktopApp({ appEnvironmentOverrides: { WEWORK_E2E_CLOUD_TOKEN: token } })
  await control.command('waitFor', '[data-testid="settings-button"]', {
    text: user.user_name,
  })
  const connection = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.equal(connection.user.id, user.id, 'The desktop retained the previous cloud identity')
}

export async function verifyBoardPreferenceIsolation(
  control,
  {
    scoped,
    executorHome,
    project,
    reader,
    creator,
    readerToken,
    creatorToken,
    restartDesktopApp,
    uiTimeoutMs,
  }
) {
  assert.equal(typeof restartDesktopApp, 'function', 'The process restart hook is missing')
  const projectKey = `personal-board-isolation-${process.pid}`
  const path = join(executorHome, projectKey)
  const localProject = {
    id: `local-code-${createHash('sha256').update(projectKey).digest('hex')}`,
    name: `个人看板本地隔离-${process.pid}`,
    workspace_id: 'wework-local-workspace',
  }
  await mkdir(path, { recursive: true })
  await control.command('seedLocalProject', 'body', {
    value: JSON.stringify({ projectKey, path, name: localProject.name }),
  })
  await reloadMainWindow(control, 'The local preference fixture did not load')
  try {
    await openProjectBoard(control, scoped, localProject)
    await createCollaborationBoardIssue(control, `个人看板本地偏好任务-${process.pid}`, 'pending')
    await assertProjectBoardGrouping(control, scoped, 'status')
    const localBefore = JSON.parse(
      await control.command('readLocalProject', 'body', { value: localProject.id })
    )
    assert.ok(localBefore, 'The real local project store did not persist the fixture')
    await selectProjectBoardGrouping(control, scoped, 'tag')
    await assertPreference(control, reader.id, 'local', localProject.id, 'tag')
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'assignee')
    await assertPreference(control, reader.id, 'backend', project.id, 'assignee')
    console.log('[desktop-e2e] PASS personal-board: local/backend storage isolation')

    // Select through the real task composer; opening a board does not change task project memory.
    await selectProjectForOwner(control, reader, localProject.name, uiTimeoutMs)
    await selectProjectForOwner(control, reader, null, uiTimeoutMs)

    // This stops and starts Electron with the same user data directory, rather than reloading React.
    await restartDesktopApp()
    await assertProjectSelection(control, reader, null, uiTimeoutMs)
    await openProjectBoard(control, scoped, localProject)
    await assertProjectBoardGrouping(control, scoped, 'tag')
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'assignee')
    console.log(
      '[desktop-e2e] PASS personal-board: preferences restored after Electron process restart'
    )

    await switchAccount(control, restartDesktopApp, creatorToken, creator)
    const creatorProjectId = await selectProjectForOwner(
      control,
      creator,
      localProject.name,
      uiTimeoutMs
    )
    const creatorStorageKey = await lastProjectStorageKey(control, creator)
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'status')
    await selectProjectBoardGrouping(control, scoped, 'priority')
    await assertPreference(control, creator.id, 'backend', project.id, 'priority')
    await openProjectBoard(control, scoped, localProject)
    await assertProjectBoardGrouping(control, scoped, 'status')
    await selectProjectBoardGrouping(control, scoped, 'priority')
    await assertPreference(control, creator.id, 'local', localProject.id, 'priority')

    await switchAccount(control, restartDesktopApp, readerToken, reader)
    await assertProjectSelection(control, reader, null, uiTimeoutMs)
    assert.equal(
      await control.command('getLocalStorageItem', 'body', {
        value: creatorStorageKey,
      }),
      String(creatorProjectId),
      'Returning to the reader overwrote the creator project selection'
    )
    console.log(
      '[desktop-e2e] PASS last-project: real account switches and Electron restart preserve owner selections'
    )
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'assignee')
    await assertPreference(control, reader.id, 'backend', project.id, 'assignee')
    await assertPreference(control, creator.id, 'backend', project.id, 'priority')
    await openProjectBoard(control, scoped, localProject)
    await assertProjectBoardGrouping(control, scoped, 'tag')
    await assertPreference(control, reader.id, 'local', localProject.id, 'tag')
    await assertPreference(control, creator.id, 'local', localProject.id, 'priority')
    console.log(
      '[desktop-e2e] PASS personal-board: real account switching isolates both project stores'
    )
    const localAfter = JSON.parse(
      await control.command('readLocalProject', 'body', { value: localProject.id })
    )
    assert.equal(localAfter.version, localBefore.version)
    assert.deepEqual(localAfter.metadata.board_config, localBefore.metadata.board_config)
    console.log('[desktop-e2e] PASS personal-board: local project configuration remained unchanged')
    await openProjectBoard(control, scoped, project)
  } finally {
    await control.command('archiveLocalProject', 'body', {
      value: JSON.stringify({ projectKey }),
    })
  }
}
