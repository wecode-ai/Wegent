import assert from 'node:assert/strict'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`

/** Real gateway, MySQL, MinIO and Electron coverage for delivery updates. */
export function createCloudDeliveryEditingRegression({ uiTimeoutMs }) {
  let cloud
  let workspace
  let project
  let issue
  let delivery
  let editorToken
  let viewerToken
  let hiddenIssue
  let asset
  let foreignAsset

  async function request(path, { method = 'GET', body, token = cloud.authToken, status } = {}) {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    })
    const text = await response.text()
    if (status)
      assert.equal(response.status, status, `${method} ${path}: ${response.status} ${text}`)
    else assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    return text ? JSON.parse(text) : null
  }

  async function member(name, role) {
    const password = 'delivery-editing-e2e-password'
    const user = await request('/api/admin/users', {
      method: 'POST',
      body: { user_name: name, password, role: 'user', auth_source: 'password' },
    })
    await request(`/api/v1/workspaces/${workspace.id}/members`, {
      method: 'POST',
      body: { user_id: user.id, role },
    })
    return (
      await request('/api/auth/login', { method: 'POST', body: { user_name: name, password } })
    ).access_token
  }

  async function createDelivery(itemId, title) {
    const draft = await request(`/api/v1/loop-items/${itemId}/deliveries`, {
      method: 'POST',
      body: { title, markdown: '云端原始备注' },
    })
    const form = new FormData()
    form.set('relative_path', 'reports/result.txt')
    form.set('file', new Blob(['original'], { type: 'text/plain' }), 'result.txt')
    const uploaded = await request(`/api/v1/deliveries/${draft.id}/assets`, {
      method: 'POST',
      body: form,
    })
    const finalized = await request(`/api/v1/deliveries/${draft.id}/finalize`, {
      method: 'POST',
      body: { fulfillments: [] },
    })
    return { delivery: finalized, asset: uploaded }
  }

  function updateForm({ version, retained = [], title = '云端修订标题', files = true }) {
    const form = new FormData()
    form.set(
      'metadata',
      JSON.stringify({
        title,
        version,
        markdown: '云端修订备注',
        chat: null,
        retained_asset_ids: retained,
        files: files
          ? [
              {
                relative_path: 'reports/result.txt',
                display_name: 'result.txt',
                content_type: 'text/plain',
              },
            ]
          : [],
      })
    )
    if (files) form.set('file_0', new Blob(['replacement'], { type: 'text/plain' }), 'result.txt')
    return form
  }

  return {
    async prepare(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', { method: 'POST' })
      workspace = await request('/api/v1/workspaces', {
        method: 'POST',
        body: { name: `交付编辑空间-${process.pid}` },
      })
      project = await request(`/api/v1/workspaces/${workspace.id}/projects`, {
        method: 'POST',
        body: {
          projectKey: 'DELIVERYEDIT',
          name: '云端交付编辑',
          taskProvider: 'local',
          providerConfig: {},
          visibility: 'private',
        },
      })
      editorToken = await member('delivery-editor', 'Developer')
      viewerToken = await member('delivery-viewer', 'Viewer')
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: { title: '云端交付编辑回归', security_level: 'open' },
      })
      hiddenIssue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, {
        method: 'POST',
        body: { title: '不可访问的交付', security_level: 'related' },
      })
      ;({ delivery, asset } = await createDelivery(issue.id, '云端原始标题'))
      foreignAsset = (await createDelivery(issue.id, '其他交付')).asset
    },

    async verify(control) {
      const path = `/api/v1/deliveries/${delivery.id}`
      await request(path, {
        method: 'PATCH',
        body: updateForm({ version: delivery.version }),
        token: viewerToken,
        status: 403,
      })
      await request(path, {
        method: 'PATCH',
        body: updateForm({ version: delivery.version, retained: [foreignAsset.id], files: false }),
        status: 422,
      })
      const hidden = await createDelivery(hiddenIssue.id, 'Restricted')
      await request(`/api/v1/deliveries/${hidden.delivery.id}`, {
        method: 'PATCH',
        body: updateForm({ version: hidden.delivery.version }),
        token: editorToken,
        status: 404,
      })
      const before = await request(`/api/v1/loop-items/${issue.id}`)
      const saved = await request(path, {
        method: 'PATCH',
        body: updateForm({ version: delivery.version }),
        token: editorToken,
      })
      assert.equal(saved.id, delivery.id)
      assert.equal(saved.delivered_at, delivery.delivered_at)
      assert.equal(saved.version, delivery.version + 1)
      assert.equal(saved.assets.length, 1)
      assert.notEqual(saved.assets[0].id, asset.id)
      const content = await fetch(
        `${cloud.backendUrl}/api/v1/delivery-assets/${saved.assets[0].id}/content`,
        { headers: { Authorization: `Bearer ${editorToken}` } }
      )
      assert.ok(content.ok)
      assert.equal(await content.text(), 'replacement')
      await request(`/api/v1/delivery-assets/${asset.id}/access`, { status: 404 })
      await request(path, {
        method: 'PATCH',
        body: updateForm({ version: delivery.version }),
        token: editorToken,
        status: 409,
      })
      assert.equal((await request(path)).version, saved.version)
      const after = await request(`/api/v1/loop-items/${issue.id}`)
      assert.equal(after.status, before.status)
      assert.equal(after.current_delivery_id, before.current_delivery_id)
      const files = await request(`/api/v1/cloud-projects/${project.id}/delivery-files`)
      assert.ok(files.items.some(file => file.asset_id === saved.assets[0].id))
      assert.ok(files.items.every(file => file.asset_id !== asset.id))

      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/${project.id}/issues/${issue.id}`,
      })
      await control.command('waitFor', scoped(`todo-detail-open-delivery-${delivery.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped(`todo-detail-open-delivery-${delivery.id}`))
      await control.command('waitFor', scoped('todo-detail-delivery-panel'), {
        text: '云端修订标题',
      })
      await control.command('click', scoped('delivery-edit'))
      await control.command('fill', scoped('delivery-edit-notes'), {
        value: '桌面保存到云端的备注',
      })
      await control.command('click', scoped('delivery-edit-save'))
      await control.command('waitFor', scoped('todo-detail-delivery-panel'), {
        text: '桌面保存到云端的备注',
      })
      assert.equal((await request(path)).markdown, '桌面保存到云端的备注')
      await control.command('click', scoped('todo-detail-delivery-close'))
    },
    diagnostics() {
      return { projectId: project?.id, issueId: issue?.id, deliveryId: delivery?.id }
    },
  }
}
