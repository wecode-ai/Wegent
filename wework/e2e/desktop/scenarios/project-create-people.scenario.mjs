import assert from 'node:assert/strict'
import { verifyProjectFieldFocus } from '../modules/project-create-focus-indicator.mjs'
import { withProjectRenderer } from '../modules/project-create-test-utils.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import {
  expandCollaborationSpaces,
  openDirectProjectCreation,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = id => `[data-testid="${id}"]`
const projectName = `project-people-${process.pid}`

async function assertCollaboratorMenuGeometry(control) {
  const menuSelector = selector('collaboration-project-create-collaborator-menu')
  await control.command('waitFor', menuSelector, { visible: true, stableMs: 200 })
  const [menu] = JSON.parse(await control.command('getElementMetrics', menuSelector))
  const [trigger] = JSON.parse(
    await control.command(
      'getElementMetrics',
      `[data-participant-field]:has(${selector('collaboration-project-create-add-collaborator')})`
    )
  )
  assert.ok(
    menu.top >= 7 && menu.bottom <= menu.viewportHeight - 7,
    'The collaborator picker must remain inside the viewport near the dialog footer'
  )
  assert.ok(
    menu.left >= 7 && menu.right <= menu.viewportWidth - 7,
    'The collaborator picker must fit narrow viewports'
  )
  const side = await control.command('getAttribute', menuSelector, { value: 'data-side' })
  const gap = side === 'top' ? trigger.top - menu.bottom : menu.top - trigger.bottom
  assert.ok(
    gap >= 5 && gap <= 7,
    `The collaborator picker must stay anchored to its field: ${JSON.stringify({ side, gap, menu, trigger })}`
  )
}

async function verifyCollaboratorWheel() {
  const panel = selector('collaboration-project-create-collaborator-panel-members')
  await withProjectRenderer(async (client, target) => {
    const command = (method, params) => client({ action: 'command', target, method, params })
    const read = async () => {
      const result = await command('Runtime.evaluate', {
        returnByValue: true,
        expression: `(() => {
          const panel = document.querySelector(${JSON.stringify(panel)})
          if (!panel) return null
          const rect = panel.getBoundingClientRect()
          const x = Math.floor(rect.left + rect.width / 2)
          const y = Math.floor(rect.top + rect.height / 2)
          const field = panel.closest('[data-testid="collaboration-project-create-collaborator-menu"]')
            ?.querySelector('input')
          const style = field ? getComputedStyle(field) : null
          return {
            x, y, hit: panel.contains(document.elementFromPoint(x, y)),
            top: panel.scrollTop, visible: panel.clientHeight, full: panel.scrollHeight,
            focus: style && { outline: style.outline, shadow: style.boxShadow }
          }
        })()`,
      })
      return result.result.value
    }
    const before = await waitForValue(
      read,
      value => value?.hit && value.full > value.visible,
      'Collaborator search results must overflow within the visible panel',
      5_000
    )
    await command('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: before.x,
      y: before.y,
      deltaX: 0,
      deltaY: 200,
    })
    const after = await waitForValue(
      read,
      value => value?.top > before.top,
      'A Chromium wheel event must scroll the collaborator results',
      5_000
    )
    console.info('[desktop-e2e] PASS collaborator wheel', JSON.stringify({ before, after }))
  })
}

export function createDesktopScenario({ workbenchReadyTimeoutMs }) {
  let cloud, workspace, participants
  async function request(path, method = 'GET', body) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${cloud.authToken}`,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    }).catch(cause => {
      throw new Error(`${method} ${path} failed`, { cause })
    })
    assert.ok(response.ok, `${method} ${path}: ${response.status}`)
    return response.json()
  }
  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      // The admin endpoint hashes passwords synchronously on the server.
      participants = []
      for (let index = 0; index < 10; index++) {
        participants.push(
          await request('/api/admin/users', 'POST', {
            user_name: `project-invitee-${process.pid}-${index}`,
            password: 'project-people-e2e-only',
            role: 'user',
            auth_source: 'password',
          })
        )
      }
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `project-people-group-${process.pid}`,
      })
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', selector('workspace-tab-select-fixed-board'))
      await control.command('waitFor', `${CONTENT} ${selector('collaboration-platform-root')}`, {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await expandCollaborationSpaces(control, CONTENT)
      const tree = `${CONTENT} ${selector(`collaboration-workspace-tree-${workspace.id}`)}`
      await control.command('waitFor', tree)
      await control.command('click', `${tree} .collaboration-workspace-identity`)
      await openDirectProjectCreation(control, CONTENT)
      await verifyProjectFieldFocus(control, 'collaboration-project-name-input', {
        previousButtonId: 'collaboration-project-create-close',
      })
      await control.command('fill', selector('collaboration-project-name-input'), {
        value: projectName,
      })
      await control.command('click', selector('collaboration-project-create-add-collaborator'))
      await assertCollaboratorMenuGeometry(control)
      await verifyProjectFieldFocus(control, 'collaboration-project-create-people-search', {
        includeParent: true,
      })
      await control.command('fill', selector('collaboration-project-create-people-search'), {
        value: `project-invitee-${process.pid}-`,
      })
      await verifyCollaboratorWheel()
      const participant = participants[0]
      await control.command('fill', selector('collaboration-project-create-people-search'), {
        value: participant.user_name,
      })
      const result = selector(`collaboration-project-create-member-${participant.id}`)
      await control.command('waitFor', result)
      await assertCollaboratorMenuGeometry(control)
      await control.command('click', result)
      await control.command(
        'waitFor',
        `${selector('collaboration-project-create-dialog')} .collaboration-project-create-collaborator-tokens`,
        {
          text: participant.user_name,
        }
      )
      await control.command('clickWhenEnabled', selector('collaboration-project-create-confirm'))
      await control.command('waitFor', `${CONTENT} ${selector('cloud-project-header-title')}`, {
        text: projectName,
      })
      const projects = await request(`/api/v1/workspaces/${workspace.id}/projects`)
      const project = projects.items.find(item => item.name === projectName)
      assert.ok(project, 'Project creation must persist the project')
      const members = await request(`/api/v1/cloud-projects/${project.id}/members`)
      assert.ok(
        members.some(member => member.user_id === participant.id && member.role === 'Developer'),
        'The selected person must be a project member'
      )
      const groupMembers = await request(`/api/v1/workspaces/${workspace.id}/members`)
      assert.ok(
        !groupMembers.items.some(member => member.user_id === participant.id),
        'Project invitation must not add the person to the parent group'
      )
    },
  }
}
