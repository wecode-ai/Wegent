import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inCollaborationSidebar } from './workspace-flows.mjs'

export async function verifyCollaborationLocalProjectImport(
  control,
  { cloudProjectId, cloudWorkspaceId, executorHome, scoped, workbenchReadyTimeoutMs }
) {
  const key = 'issue-home-local-project-e2e'
  const path = join(executorHome, 'issue-home-project')
  await mkdir(path, { recursive: true })
  const projectId = `local-code-${createHash('sha256').update(key).digest('hex')}`
  const projectName = '任务项目自动进入本地空间'
  await control.command('seedLocalProject', 'body', {
    value: JSON.stringify({ projectKey: key, name: projectName, path }),
  })
  const row = inCollaborationSidebar(`[data-testid="collaboration-workspace-project-${projectId}"]`)
  for (let pass = 0; pass < 2; pass += 1) {
    const readyCount = control.readyCount
    await control.command('reloadApp', 'body')
    await control.awaitReadyAfter(readyCount)
    await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
    const toggle = inCollaborationSidebar(
      '[data-testid="collaboration-workspace-toggle-wework-local-workspace"]'
    )
    const localWorkspace = inCollaborationSidebar(
      '[data-testid="collaboration-workspace-wework-local-workspace"]'
    )
    const cloudWorkspace = inCollaborationSidebar(
      `[data-testid="collaboration-workspace-${cloudWorkspaceId}"]`
    )
    const cloudToggle = inCollaborationSidebar(
      `[data-testid="collaboration-workspace-toggle-${cloudWorkspaceId}"]`
    )
    const cloudProject = inCollaborationSidebar(
      `[data-testid="collaboration-workspace-project-${cloudProjectId}"]`
    )
    await control.command('waitFor', toggle)
    await control.command('waitFor', cloudWorkspace)
    await control.command('waitFor', cloudToggle)
    if (
      (await control.command('getAttribute', cloudToggle, { value: 'aria-expanded' })) !== 'true'
    ) {
      await control.command('click', cloudToggle)
    }
    await control.command('waitFor', cloudProject)
    assert.equal(
      await control.command(
        'getAttribute',
        inCollaborationSidebar(
          '[data-testid="collaboration-workspace-location-wework-local-workspace"]'
        ),
        { value: 'data-location' }
      ),
      'local',
      'The local Workspace must use the local device icon'
    )
    assert.equal(
      await control.command(
        'getAttribute',
        inCollaborationSidebar(
          `[data-testid="collaboration-workspace-location-${cloudWorkspaceId}"]`
        ),
        { value: 'data-location' }
      ),
      'cloud',
      'The cloud Workspace must use the cloud icon'
    )
    assert.match(await control.command('getText', localWorkspace), /本地/)
    assert.match(await control.command('getText', cloudWorkspace), /云端/)
    const [sidebarMetrics] = JSON.parse(
      await control.command(
        'getElementMetrics',
        scoped('[data-testid="collaboration-platform-sidebar"]')
      )
    )
    assert.ok(
      sidebarMetrics.scrollWidth <= sidebarMetrics.clientWidth + 1,
      `The Collaboration sidebar overflowed horizontally: ${sidebarMetrics.scrollWidth}px > ${sidebarMetrics.clientWidth}px`
    )
    if ((await control.command('getAttribute', toggle, { value: 'aria-expanded' })) !== 'true') {
      await control.command('click', toggle)
    }
    await control.command('waitFor', row, { text: projectName })
    assert.equal(
      Number(await control.command('getElementCount', row)),
      1,
      'Reload must not duplicate imported Task projects'
    )
    assert.equal(Number(await control.command('getElementCount', `${row} svg`)), 0)
    await control.command('hover', row)
    await control.command(
      'click',
      inCollaborationSidebar(`[data-testid="collaboration-project-new-conversation-${projectId}"]`)
    )
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-issue-project-trigger"]'),
      { text: projectName }
    )
    assert.equal(
      Number(await control.command('getElementCount', scoped('.collaboration-loading'))),
      0,
      'Opening the local Issue composer must not restart the global Collaboration loading state'
    )
    assert.equal(
      Number(await control.command('getElementCount', scoped('[role="alert"]'))),
      0,
      'Opening the local Issue composer must not report a cloud member or Issue loading error'
    )
    assert.equal(
      Number(await control.command('getElementCount', cloudWorkspace)),
      1,
      'Opening a local Issue composer must preserve cloud Workspaces in navigation'
    )
    assert.equal(
      Number(await control.command('getElementCount', cloudProject)),
      1,
      'Opening a local Issue composer must preserve cloud Projects in navigation'
    )
  }
}
