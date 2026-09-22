import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runChecked } from './shared.mjs'
import { createLocalCollaborationProject, inCollaborationSidebar } from './workspace-flows.mjs'

async function waitForLocalProject(control, projectId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const project = JSON.parse(
      await control.command('readLocalProject', 'body', { value: projectId })
    )
    if (project?.metadata?.execution_environment) return project
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  assert.fail(`The local collaboration Project ${projectId} did not persist its Git environment`)
}

export async function verifyCollaborationLocalProjectImport(
  control,
  { cloudProjectId, cloudWorkspaceId, executorHome, scoped, workbenchReadyTimeoutMs }
) {
  const key = 'issue-home-local-project-e2e'
  const path = join(executorHome, 'issue-home-project')
  const repositoryUrl = 'https://github.com/wecode-ai/issue-home-project.git'
  await mkdir(path, { recursive: true })
  await runChecked('git', ['init', '-b', 'main'], { cwd: path })
  await writeFile(join(path, 'README.md'), '# Issue home project\n')
  await runChecked('git', ['config', 'user.name', 'Wework E2E'], { cwd: path })
  await runChecked('git', ['config', 'user.email', 'wework-e2e@example.com'], { cwd: path })
  await runChecked('git', ['add', 'README.md'], { cwd: path })
  await runChecked('git', ['commit', '-m', 'Initial commit'], { cwd: path })
  await runChecked('git', ['remote', 'add', 'origin', repositoryUrl], { cwd: path })
  const projectId = `local-code-${createHash('sha256').update(key).digest('hex')}`
  const projectName = '任务项目自动进入本地空间'
  const importedProjectName = '协作空间后续导入项目'
  await control.command('seedLocalProject', 'body', {
    value: JSON.stringify({ projectKey: key, name: projectName, path }),
  })
  const localProject = await waitForLocalProject(control, projectId, workbenchReadyTimeoutMs)
  assert.deepEqual(
    localProject.metadata.execution_environment,
    {
      repositories: [
        {
          name: 'issue-home-project',
          path: 'issue-home-project',
          primary: true,
          ref: 'main',
          url: repositoryUrl,
        },
      ],
      setup_steps: [],
    },
    'The generated collaboration Project did not inherit the current Git repository'
  )
  const worktreePreflight = JSON.parse(
    await control.command('preflightLocalWorktree', 'body', {
      value: JSON.stringify({ sourcePath: path, ref: 'main' }),
    })
  )
  assert.equal(worktreePreflight.supported, true, 'The executor does not support worktrees')
  assert.equal(worktreePreflight.gitRepository, true, 'The imported project is not Git-backed')
  assert.equal(worktreePreflight.refValid, true, 'The imported project branch is not usable')
  assert.equal(
    worktreePreflight.gitCommonDirWritable,
    true,
    'The imported project cannot create worktrees'
  )
  await control.command('archiveLocalProject', 'body', {
    value: JSON.stringify({ projectKey: key }),
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
    const localWorkspaceTree = inCollaborationSidebar(
      '[data-testid="collaboration-workspace-tree-wework-local-workspace"]'
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
    const localDomain = scoped('[data-testid="collaboration-domain-local"]')
    const cloudDomain = scoped('[data-testid="collaboration-domain-cloud"]')
    await control.command('waitFor', toggle)
    await control.command('waitFor', cloudWorkspace)
    await control.command('waitFor', cloudToggle)
    await control.command('waitFor', localDomain)
    await control.command('waitFor', cloudDomain)
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
    assert.match(await control.command('getText', localDomain), /本地协作/)
    assert.match(await control.command('getText', cloudDomain), /云端协作/)
    assert.ok(
      (await control.command('getText', localWorkspace)).trim(),
      'The local Workspace name must remain visible in the local domain'
    )
    assert.ok(
      (await control.command('getText', cloudWorkspace)).trim(),
      'The cloud Workspace name must remain visible in the cloud domain'
    )
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
    if (pass === 0) {
      assert.equal(
        Number(await control.command('getElementCount', row)),
        0,
        'An archived Task project must remain absent before explicit import'
      )
      await control.command('click', localWorkspace)
      await control.command(
        'click',
        `${localWorkspaceTree} [data-testid="collaboration-workspace-actions"]`
      )
      await control.command('click', '[data-testid="collaboration-workspace-nav-create-project"]')
      await control.command(
        'click',
        '[data-testid="collaboration-workspace-nav-import-existing-project"]'
      )
      await control.command('waitFor', '[data-testid="existing-local-project-import-dialog"]')
      await control.command(
        'markElementWithText',
        '[data-testid^="existing-local-project-option-"]',
        {
          text: projectName,
          value: 'collaboration-existing-project-option',
        }
      )
      await control.command('click', '[data-e2e-anchor-id="collaboration-existing-project-option"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="confirm-existing-local-project-import"]'
      )
      await control.command('waitFor', row, {
        text: projectName,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            '[data-testid="existing-local-project-import-dialog"]'
          )
        ),
        0,
        'Explicit import must close the project picker after synchronization'
      )
    } else {
      await control.command('waitFor', row, { text: projectName })
    }
    assert.equal(
      Number(await control.command('getElementCount', row)),
      1,
      'Reload must not duplicate imported Task projects'
    )
    assert.equal(Number(await control.command('getElementCount', `${row} svg`)), 0)
    const projectRows = inCollaborationSidebar('[data-testid^="collaboration-workspace-project-"]')
    if (pass === 0) {
      await createLocalCollaborationProject(control, scoped('').trim(), importedProjectName)
    }
    await control.command('waitFor', projectRows, {
      text: importedProjectName,
      timeoutMs: workbenchReadyTimeoutMs,
    })
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
