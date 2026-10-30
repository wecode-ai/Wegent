import { basename } from 'node:path'
import {
  assert,
  CLOUD_DEVICE_ID,
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
  await control.command('waitFor', '[data-testid="cloud-work-projects-section"]', {
    text: targetPath,
  })
  await waitForSnapshot(
    control,
    snapshot => !snapshot.testIds.includes('standalone-folder-project-dialog'),
    'The cloud work sidebar clone did not close after adding the project'
  )
  await runChecked('git', ['rev-parse', '--is-inside-work-tree'], { cwd: targetPath })
  await control.command('navigate', 'body', { value: '/' })
  await control.command('waitFor', '[data-testid="projects-create-button"]')
}
