import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { inCollaborationSidebar } from './workspace-flows.mjs'

export async function verifyCollaborationLocalProjectImport(
  control,
  { executorHome, scoped, workbenchReadyTimeoutMs }
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
    await control.command('waitFor', toggle)
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
  }
}
