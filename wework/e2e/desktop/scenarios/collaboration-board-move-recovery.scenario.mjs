import assert from 'node:assert/strict'

import { dragBoardCard, waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { TransportFaultProxy } from '../modules/transport-fault-proxy.mjs'
import { reloadMainWindow, selectCollaborationDomain } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const lane = status => scoped(`[data-testid="cloud-todo-column-${status}"]`)
const card = id => `[data-testid="cloud-todo-card-${id}"]`

// Real backend commits and snapshots; only delivery of their responses is faulted.
export function createDesktopScenario({ uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const appEnvironment = {}
  let cloud
  let proxy
  let workspace
  let project
  const issues = []
  const snapshotPath = () => `/api/v1/cloud-projects/${project.id}/board-snapshot`
  const request = async (path, method = 'GET', values) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cloud.authToken}`, 'Content-Type': 'application/json' },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const body = await response.text()
    assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${body}`)
    return body ? JSON.parse(body) : null
  }
  const snapshot = () => request(snapshotPath())
  const serverOrder = async () =>
    (await snapshot()).items.sort((a, b) => a.sort_order - b.sort_order).map(item => item.id)
  const wait = (load, expected, message) => waitForBoardValue(load, expected, message, uiTimeoutMs)
  const expectOrder = (control, status, ids) =>
    wait(
      async () =>
        JSON.parse(await control.command('getTestIdOrder', lane(status)))
          .filter(id => id.startsWith('cloud-todo-card-drop-'))
          .map(id => id.slice('cloud-todo-card-drop-'.length)),
      ids,
      `Unexpected ${status} order`
    )
  const drag = (control, id, sourceStatus, beforeId) =>
    dragBoardCard(
      control,
      `${lane(sourceStatus)} ${card(id)}`,
      `${lane('pending')} [data-testid="cloud-todo-card-drop-${beforeId}"]`,
      uiTimeoutMs
    )
  async function openBoard(control) {
    await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
    await control.command('waitFor', scoped('[data-testid="collaboration-tab-board"]'), {
      timeoutMs: workbenchReadyTimeoutMs,
    })
    await control.command('click', scoped('[data-testid="collaboration-tab-board"]'))
    await control.command('waitFor', scoped(card(issues[2].id)), { timeoutMs: uiTimeoutMs })
  }
  async function patch(id, values) {
    const current = await request(`/api/v1/loop-items/${id}`)
    return request(`/api/v1/loop-items/${id}`, 'PATCH', { version: current.version, ...values })
  }

  return {
    requiresCloudEnvironment: true,
    appEnvironment,
    async prepareCloud(environment) {
      cloud = environment
      proxy = await new TransportFaultProxy(cloud.backendUrl).start()
      appEnvironment.WEWORK_E2E_CLOUD_BACKEND_URL = proxy.url
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', {
        name: `Move recovery ${process.pid}`,
      })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: 'Board move recovery',
        task_provider: 'local',
        visibility: 'private',
      })
      for (const title of ['Card A', 'Card B', 'Card C']) {
        issues.push(
          await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
            title,
            priority: 'high',
            status: 'pending',
          })
        )
      }
      await request(`/api/v1/cloud-projects/${project.id}/loop-items/reorder`, 'POST', {
        parent_id: null,
        status: null,
        item_ids: issues.map(item => item.id),
      })
    },
    async verify(control) {
      const [a, b, c] = issues
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await selectCollaborationDomain(control, CONTENT, 'cloud')
      await openBoard(control)
      const sort = scoped('[data-testid="cloud-board-sort-by-pending"]')
      await control.command('click', sort)
      await control.command('click', '[data-testid="cloud-board-sort-by-pending-manual"]')
      await control.command('click', sort)
      await expectOrder(control, 'pending', [a.id, b.id, c.id])

      // A0/B1/C2 -> B0/A1/C2. The successful PATCH is never faulted.
      proxy.rule = entry => (entry.path === snapshotPath() ? 'drop-response' : null)
      await drag(control, a.id, 'pending', c.id)
      await wait(
        () => proxy.requests.some(entry => entry.dropped),
        true,
        'No real snapshot was dropped'
      )
      await control.command('waitFor', scoped('[role="alert"]'), { timeoutMs: uiTimeoutMs })
      await expectOrder(control, 'pending', [b.id, a.id, c.id])
      assert.deepEqual(await serverOrder(), [b.id, a.id, c.id])
      assert.equal(proxy.requests.filter(entry => entry.method === 'PATCH').length, 1)
      proxy.rule = () => null
      await reloadMainWindow(control, 'Board move recovery did not reopen')
      await openBoard(control)
      await expectOrder(control, 'pending', [b.id, a.id, c.id])
      await control.command('waitFor', scoped('[role="alert"]'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })

      // The first move is still awaiting its snapshot while the second move commits.
      // B/A/C ensures the first move does not invalidate B's version.
      await patch(a.id, { status: 'in_review', position: { beforeItemId: c.id } })
      await patch(b.id, { status: 'in_review', position: { beforeItemId: a.id } })
      await reloadMainWindow(control, 'Overlapping move fixtures did not reopen')
      await openBoard(control)
      await expectOrder(control, 'in_review', [b.id, a.id])
      let armed = false
      proxy.rule = entry => {
        if (entry.method === 'PATCH' && entry.path === `/api/v1/loop-items/${a.id}`) {
          armed = true
          return null
        }
        if (!armed || entry.path !== snapshotPath()) return null
        armed = false
        return 'hold-response'
      }
      await drag(control, a.id, 'in_review', c.id)
      await wait(
        () => proxy.requests.some(entry => entry.committedResponseHeld),
        true,
        'First move snapshot was not held'
      )
      const held = proxy.requests.find(entry => entry.committedResponseHeld)
      assert.equal(held.status, 200)
      assert.equal(held.released, undefined)
      await patch(a.id, { title: 'Card A confirmed', priority: 'urgent', tags: ['confirmed'] })
      const secondStart = proxy.requests.length
      await drag(control, b.id, 'in_review', c.id)
      await wait(
        () =>
          proxy.requests
            .slice(secondStart)
            .some(entry => entry.path === snapshotPath() && entry.delivered),
        true,
        'Second snapshot did not arrive before the first'
      )
      await expectOrder(control, 'pending', [a.id, b.id, c.id])
      await control.command('waitFor', scoped(card(a.id)), {
        text: 'Card A confirmed',
        timeoutMs: uiTimeoutMs,
      })
      const finalItems = (await snapshot()).items
      assert.deepEqual(await serverOrder(), [a.id, b.id, c.id])
      assert.equal(finalItems.find(item => item.id === a.id).status, 'pending')
      assert.equal(finalItems.find(item => item.id === b.id).status, 'pending')
      assert.equal(held.released, undefined)
      const visibleCards = () =>
        Promise.all(issues.map(issue => control.command('getText', scoped(card(issue.id)))))
      const confirmedCards = await visibleCards()
      await held.release()
      // Keep the newer card stable across delivery and rendering of the late snapshot.
      await control.command('waitFor', scoped(card(a.id)), {
        text: 'Card A confirmed',
        stableMs: 1500,
        timeoutMs: uiTimeoutMs,
      })
      await control.command('waitFor', scoped(`${card(a.id)} [title="confirmed"]`), {
        timeoutMs: uiTimeoutMs,
      })
      await expectOrder(control, 'pending', [a.id, b.id, c.id])
      assert.deepEqual(await visibleCards(), confirmedCards)
      await control.command('click', scoped(card(a.id)))
      await control.command('waitFor', scoped('[data-testid="collaboration-issue-detail"]'), {
        text: 'Card A confirmed',
        timeoutMs: uiTimeoutMs,
      })
      const fields = items =>
        items.map(({ id, title, status, priority, tags, version, sort_order }) => ({
          id,
          title,
          status,
          priority,
          tags,
          version,
          sort_order,
        }))
      assert.deepEqual(fields((await snapshot()).items), fields(finalItems))
      proxy.rule = () => null
      await reloadMainWindow(control, 'Overlapping moves did not survive reopening')
      await openBoard(control)
      await expectOrder(control, 'pending', [a.id, b.id, c.id])
      await control.command('waitFor', scoped(card(a.id)), {
        text: 'Card A confirmed',
        timeoutMs: uiTimeoutMs,
      })
    },
    diagnostics: () => ({ projectId: project?.id, requests: proxy?.requests }),
    async cleanup() {
      await proxy?.stop()
      if (project) {
        const current = await request(`/api/v1/cloud-projects/${project.id}`)
        await request(`/api/v1/cloud-projects/${project.id}?version=${current.version}`, 'DELETE')
      }
      if (workspace) {
        const current = await request(`/api/v1/workspaces/${workspace.id}`)
        await request(`/api/v1/workspaces/${workspace.id}?version=${current.version}`, 'DELETE')
      }
    },
  }
}
