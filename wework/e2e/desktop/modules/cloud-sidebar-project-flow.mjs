import { basename } from 'node:path'
import {
  assert,
  CLOUD_DEVICE_ID,
  REMOTE_DOCKER_DEVICE_ID,
  commandOutput,
  fetchJson,
  join,
  mkdir,
  runChecked,
  WORKBENCH_READY_TIMEOUT_MS,
} from './shared.mjs'
import { waitForControlValue } from './workspace-flows.mjs'
import { waitForSnapshot } from './conversation-layout.mjs'

export async function verifyCloudSidebarGitClone(control, workspacePath, homePath) {
  const parentPath = join(homePath, 'cloud-sidebar-clones')
  const targetPath = join(parentPath, basename(workspacePath))
  await mkdir(parentPath, { recursive: true })
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-page"]', {
    timeoutMs: WORKBENCH_READY_TIMEOUT_MS,
  })
  await control.command('clickWhenEnabled', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-source-git"]')
  await waitForControlValue(
    control,
    '[data-testid="remote-project-git-parent-input"]',
    homePath,
    'The cloud work sidebar clone form did not load the executor home'
  )
  await control.command('fill', '[data-testid="remote-project-git-parent-input"]', {
    value: parentPath,
  })
  await control.command('fill', '[data-testid="remote-project-git-url-input"]', {
    value: workspacePath,
  })
  await control.command('click', '[data-testid="remote-project-git-advanced-toggle"]')
  await control.command('fill', '[data-testid="remote-project-git-branch-input"]', {
    value: 'invalid..branch',
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
  await control.command('waitFor', '[data-testid="remote-project-git-error"]', {
    text: 'invalid..branch',
  })
  assert.equal(
    await control.command('getValue', '[data-testid="remote-project-git-url-input"]'),
    workspacePath,
    'A failed sidebar clone discarded the repository URL'
  )

  await control.command('fill', '[data-testid="remote-project-git-branch-input"]', { value: '' })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
  // Opening the cloned workspace navigates away from the cloud work page.
  await waitForSnapshot(
    control,
    snapshot =>
      snapshot.testIds.includes('desktop-workbench-main') &&
      !snapshot.testIds.includes('standalone-folder-project-dialog'),
    'The cloud work sidebar clone did not open the project in the workbench'
  )
  await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetPath })
  await control.command('navigate', 'body', { value: '/cloud-work' })
  await control.command('waitFor', '[data-testid="cloud-work-projects-section"]', {
    text: targetPath,
  })
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="projects-create-button"]')
}

export async function verifyGitCloneDeviceRecovery(control, workspacePath, cloud) {
  assert.equal(new URL(cloud.backendUrl).hostname, '127.0.0.1')
  const oldParent = join(cloud.remoteExecutorEnv.HOME, 'removed-device-clone')
  const newParent = join(cloud.remoteDockerExecutorEnv.HOME, 'recovered-device-clone')
  const expectedPath = join(newParent, basename(workspacePath))
  const branch = commandOutput('git', ['branch', '--show-current'], { cwd: workspacePath })
  assert.ok(branch, 'The recovery fixture must have a named Git branch')
  const oldDevice = await cloud.device(CLOUD_DEVICE_ID)
  assert.ok(oldDevice, 'The original clone device must be registered')
  const user = await fetchJson(`${cloud.backendUrl}/api/users/me`, {
    headers: { Authorization: `Bearer ${cloud.authToken}` },
  })
  const identity = [user.id, 'default', CLOUD_DEVICE_ID]
  const rows = await cloud.queryDatabase(
    "SELECT id FROM kinds WHERE user_id=%s AND kind='Device' AND namespace=%s AND name=%s AND is_active=1",
    identity
  )
  assert.equal(rows.length, 1, 'The fixture must select exactly one owned device')

  await control.command('clickWhenEnabled', '[data-testid="projects-create-button"]')
  await control.command('click', '[data-testid="project-create-remote-option"]')
  await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
    value: CLOUD_DEVICE_ID,
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-source-git"]')
  await control.command('fill', '[data-testid="remote-project-git-parent-input"]', {
    value: oldParent,
  })
  await control.command('fill', '[data-testid="remote-project-git-url-input"]', {
    value: workspacePath,
  })
  await control.command('click', '[data-testid="remote-project-git-advanced-toggle"]')
  await control.command('fill', '[data-testid="remote-project-git-branch-input"]', {
    value: 'invalid..branch',
  })
  await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
  await control.command('waitFor', '[data-testid="git-clone-project-operations"]', {
    text: '克隆失败',
  })

  // Remove the real device from discovery without spawning another Executor.
  // The existing second Executor is the explicit recovery destination.
  await cloud.executeDatabase(
    "UPDATE kinds SET is_active=0 WHERE user_id=%s AND kind='Device' AND namespace=%s AND name=%s",
    identity
  )
  try {
    assert.equal(await cloud.device(CLOUD_DEVICE_ID), null)
    await control.command('clickWhenEnabled', '[data-testid="projects-create-button"]')
    await control.command('click', '[data-testid="project-create-remote-option"]')
    await waitForControlValue(
      control,
      '[data-testid="standalone-remote-device-select"]',
      REMOTE_DOCKER_DEVICE_ID,
      'The refreshed device picker retained the removed Executor'
    )
    assert.equal(
      await control.command(
        'getElementCount',
        `[data-testid="standalone-remote-device-option-${CLOUD_DEVICE_ID}"]`
      ),
      '0'
    )
    await control.command('click', '[data-testid="close-standalone-folder-project-dialog"]')
    const retry = 'button[data-testid^="retry-git-clone-project-"]'
    await control.command('click', retry)
    await control.command('waitFor', '[data-testid="git-clone-project-operations"]', {
      text: '设备不可用',
    })
    await control.command('click', retry)
    await waitForControlValue(
      control,
      '[data-testid="remote-project-git-url-input"]',
      workspacePath,
      'Device recovery lost the original repository URL'
    )
    assert.equal(
      await control.command('getValue', '[data-testid="remote-project-git-parent-input"]'),
      oldParent
    )
    assert.equal(
      await control.command('getValue', '[data-testid="remote-project-git-branch-input"]'),
      'invalid..branch'
    )
    assert.equal(
      await control.command('getElementCount', '[data-testid="standalone-folder-project-dialog"]'),
      '1'
    )
    await control.command('fill', '[data-testid="standalone-remote-device-select"]', {
      value: REMOTE_DOCKER_DEVICE_ID,
    })
    await control.command('fill', '[data-testid="remote-project-git-parent-input"]', {
      value: newParent,
    })
    await control.command('fill', '[data-testid="remote-project-git-branch-input"]', {
      value: branch,
    })
    await control.command('clickWhenEnabled', '[data-testid="remote-project-git-submit"]')
    await control.command('waitFor', '[data-testid="git-clone-project-operations"]', {
      visible: false,
    })
    await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: expectedPath })
    const response = await cloud.runtimeWork()
    const workspaces = [
      ...response.projects.flatMap(project => project.deviceWorkspaces),
      ...response.chats,
    ]
    assert.ok(
      workspaces.some(
        workspace =>
          workspace.deviceId === REMOTE_DOCKER_DEVICE_ID && workspace.workspacePath === expectedPath
      ),
      'The cloned project was not registered on the selected replacement device'
    )
  } finally {
    await cloud.executeDatabase(
      "UPDATE kinds SET is_active=1 WHERE user_id=%s AND kind='Device' AND namespace=%s AND name=%s",
      identity
    )
  }
}
