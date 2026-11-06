import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { resultDir } from '../modules/shared.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`

export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud, workspace, sibling, project, issue
  const request = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  const tree = id => scoped(`[data-testid="collaboration-workspace-tree-${id}"]`)
  const openSpaceDeletion = async control => {
    await control.command('hover', `${tree(workspace.id)} .collaboration-workspace-row`)
    await control.command(
      'click',
      `${tree(workspace.id)} [data-testid^="collaboration-workspace-actions"][aria-haspopup="menu"]`
    )
    await control.command('click', `[data-testid="collaboration-workspace-delete-${workspace.id}"]`)
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-workspace-delete-dialog"]'),
      {
        text: workspace.name,
        visible: true,
        timeoutMs: uiTimeoutMs,
      }
    )
  }
  const openProjectDeletion = async (control, id) => {
    await control.command('hover', scoped(`[data-testid="collaboration-workspace-project-${id}"]`))
    await control.command('click', scoped(`[data-testid="collaboration-project-menu-${id}"]`))
    await control.command('click', `[data-testid="collaboration-project-archive-${id}"]`)
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-project-archive-dialog"]'),
      {
        visible: true,
        timeoutMs: uiTimeoutMs,
      }
    )
  }
  const confirmProjectDeletion = async (control, id) => {
    await control.command('click', scoped('[data-testid="collaboration-project-archive-confirm"]'))
    await control.command(
      'waitFor',
      scoped(`[data-testid="collaboration-workspace-project-${id}"]`),
      {
        visible: false,
        timeoutMs: uiTimeoutMs,
      }
    )
    await control.command(
      'waitFor',
      scoped('[data-testid="collaboration-project-archive-dialog"]'),
      {
        visible: false,
        timeoutMs: uiTimeoutMs,
      }
    )
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Delete space ${process.pid}`,
      })
      sibling = await request('/api/v1/workspaces', 'POST', { name: `Keep space ${process.pid}` })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, 'POST', {
        name: `Delete project ${process.pid}`,
        task_provider: 'local',
        visibility: 'private',
      })
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: `Retained Issue ${process.pid}`,
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', tree(workspace.id), {
        visible: true,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-workspace-home-${workspace.id}"]`)
      )
      await openSpaceDeletion(control)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-delete-confirm"]')
      )
      await control.command(
        'waitFor',
        scoped('[data-testid="collaboration-workspace-delete-dialog"] [role="alert"]'),
        {
          text: 'Archive or move active Projects',
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.ok((await request('/api/v1/workspaces')).items.some(item => item.id === workspace.id))
      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-delete-cancel"]')
      )

      // Open the child board so deletion also verifies leaving the deleted project.
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
      )
      await openProjectDeletion(control, project.id)
      await control.command('click', scoped('[data-testid="collaboration-project-archive-cancel"]'))
      assert.ok(
        (await request('/api/v1/cloud-projects')).items.some(item => item.id === project.id)
      )
      await openProjectDeletion(control, project.id)
      await confirmProjectDeletion(control, project.id)
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-undo-delete-project-${project.id}"]`)
      )
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.ok(
        (await request('/api/v1/cloud-projects')).items.some(item => item.id === project.id)
      )
      await openProjectDeletion(control, project.id)
      await confirmProjectDeletion(control, project.id)
      assert.ok(
        !(await request('/api/v1/cloud-projects')).items.some(item => item.id === project.id)
      )
      await reloadMainWindow(control, 'The deleted project did not stay removed after reload')
      await control.command('waitFor', tree(workspace.id), {
        visible: true,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`)
          )
        ),
        0
      )

      await openSpaceDeletion(control)
      await control.command(
        'click',
        scoped('[data-testid="collaboration-workspace-delete-confirm"]')
      )
      await control.command('waitFor', tree(workspace.id), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      assert.ok(!(await request('/api/v1/workspaces')).items.some(item => item.id === workspace.id))
      await reloadMainWindow(control, 'The deleted space did not stay removed after reload')
      await control.command('waitFor', tree(sibling.id), {
        visible: true,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(Number(await control.command('getElementCount', tree(workspace.id))), 0)

      await control.command('click', scoped('[data-testid="collaboration-recycle-bin-open"]'))
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-recycle-bin-item-workspace-${workspace.id}"]`),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      const retained = (await request('/api/v1/recycle-bin')).items
      assert.ok(retained.some(item => item.kind === 'workspace' && item.id === workspace.id))
      assert.ok(
        retained.some(
          item => item.kind === 'project' && item.id === project.id && item.parentDeleted
        )
      )
      const blockedRestore = await fetch(
        `${cloud.backendUrl}/api/v1/recycle-bin/project/${project.id}/restore`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cloud.authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            version: retained.find(item => item.id === project.id && item.kind === 'project')
              .version,
          }),
        }
      )
      assert.equal(blockedRestore.status, 409)
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-recycle-bin-restore-workspace-${workspace.id}"]`)
      )
      await control.command('waitFor', tree(workspace.id), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      await control.command(
        'waitFor',
        scoped(
          `[data-testid="collaboration-recycle-bin-restore-project-${project.id}"]:not(:disabled)`
        ),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-recycle-bin-restore-project-${project.id}"]`)
      )
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      assert.ok(
        (await request(`/api/v1/cloud-projects/${project.id}/loop-items`)).items.some(
          item => item.id === issue.id
        )
      )
      await reloadMainWindow(control, 'Recovered resources did not persist after reload')
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-workspace-project-${project.id}"]`),
        {
          visible: true,
          timeoutMs: workbenchReadyTimeoutMs,
        }
      )

      const localName = `Local delete ${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, localName)
      const selectedId = await control.command(
        'getAttribute',
        scoped('button.collaboration-workspace-project.active'),
        { value: 'data-testid' }
      )
      const localId = selectedId.slice('collaboration-workspace-project-'.length)
      await openProjectDeletion(control, localId)
      await confirmProjectDeletion(control, localId)
      const codePath = join(
        resultDir,
        'local-collaboration-projects',
        localName.replace(/[^\p{L}\p{N}._-]+/gu, '-')
      )
      await access(join(codePath, '.git'))
      await reloadMainWindow(control, 'The deleted local project did not stay removed after reload')
      await control.command('waitFor', tree('wework-local-workspace'), {
        visible: true,
        timeoutMs: workbenchReadyTimeoutMs,
      })
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            scoped(`[data-testid="collaboration-workspace-project-${localId}"]`)
          )
        ),
        0
      )
      await access(join(codePath, '.git'))
      await control.command('click', scoped('[data-testid="collaboration-recycle-bin-open"]'))
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-recycle-bin-item-project-${localId}"]`),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await control.command(
        'click',
        scoped(`[data-testid="collaboration-recycle-bin-restore-project-${localId}"]`)
      )
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-workspace-project-${localId}"]`),
        {
          visible: true,
          timeoutMs: uiTimeoutMs,
        }
      )
      await access(join(codePath, '.git'))
      await reloadMainWindow(control, 'The restored local project did not persist after reload')
      await control.command(
        'waitFor',
        scoped(`[data-testid="collaboration-workspace-project-${localId}"]`),
        {
          visible: true,
          timeoutMs: workbenchReadyTimeoutMs,
        }
      )
    },
  }
}
