import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  assertProjectBoardGrouping,
  openProjectBoard,
  selectProjectBoardGrouping,
} from './collaboration-board-personal-view.mjs'
import { reloadMainWindow } from './workspace-flows.mjs'
import { createCollaborationBoardIssue } from './collaboration-board-issue.mjs'

const preferenceKey = (userId, store, projectId) =>
  `collaboration-board-group:v1:${userId}:${store}:${projectId}`

async function assertPreference(control, userId, store, projectId, expected) {
  assert.equal(
    await control.command('getLocalStorageItem', 'body', {
      value: preferenceKey(userId, store, projectId),
    }),
    expected,
    `The ${store} Project preference was not isolated for user ${userId}`
  )
}

async function switchAccount(control, restartDesktopApp, token, user) {
  await control.command('hover', '[data-testid="sidebar-cloud-connection-button"]')
  await control.command('click', '[data-testid="sidebar-cloud-management-button"]')
  await control.command('waitFor', '[data-testid="settings-cloud-disconnect-button"]')
  await control.command('click', '[data-testid="settings-cloud-disconnect-button"]')
  await control.command('waitFor', '[data-testid="settings-cloud-connect-button"]')
  // Bootstrap authenticates this real backend token with /users/me before mounting the workbench.
  await restartDesktopApp({ appEnvironmentOverrides: { WEWORK_E2E_CLOUD_TOKEN: token } })
  await control.command('waitFor', '[data-testid="sidebar-cloud-connection-button"]', {
    text: user.user_name,
  })
  const connection = JSON.parse(
    await control.command('getLocalStorageItem', 'body', { value: 'wework.cloudConnection' })
  )
  assert.equal(connection.user.id, user.id, 'The desktop retained the previous cloud identity')
}

export async function verifyBoardPreferenceIsolation(
  control,
  { scoped, executorHome, project, reader, creator, readerToken, creatorToken, restartDesktopApp }
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

    // This stops and starts Electron with the same user data directory, rather than reloading React.
    await restartDesktopApp()
    await openProjectBoard(control, scoped, localProject)
    await assertProjectBoardGrouping(control, scoped, 'tag')
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'assignee')
    console.log(
      '[desktop-e2e] PASS personal-board: preferences restored after Electron process restart'
    )

    await switchAccount(control, restartDesktopApp, creatorToken, creator)
    await openProjectBoard(control, scoped, project)
    await assertProjectBoardGrouping(control, scoped, 'status')
    await selectProjectBoardGrouping(control, scoped, 'priority')
    await assertPreference(control, creator.id, 'backend', project.id, 'priority')
    await openProjectBoard(control, scoped, localProject)
    await assertProjectBoardGrouping(control, scoped, 'status')
    await selectProjectBoardGrouping(control, scoped, 'priority')
    await assertPreference(control, creator.id, 'local', localProject.id, 'priority')

    await switchAccount(control, restartDesktopApp, readerToken, reader)
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
