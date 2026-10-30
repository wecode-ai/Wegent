import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { reloadMainWindow } from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const testId = name => scoped(`[data-testid="${name}"]`)

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let source
  let consumerToken
  const projectName = `模板协作验收-${process.pid}`
  const savedName = `团队标准流程-${process.pid}`
  const request = async (path, method = 'GET', values, token = cloud.authToken, expected) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    })
    const text = await response.text()
    if (expected === undefined)
      assert.ok(response.ok, `${method} ${path}: ${response.status} ${text}`)
    else assert.equal(response.status, expected, `${method} ${path}: ${text}`)
    return text ? JSON.parse(text) : null
  }
  const capture = (control, name) =>
    captureScreenshot(control, `collaboration-templates-${name}.png`, CONTENT)
  const click = (control, name) => control.command('click', testId(name))
  const wait = (control, name, text) =>
    control.command('waitFor', testId(name), { text, timeoutMs: uiTimeoutMs })
  const fillRoles = async (control, count) => {
    for (let index = 1; index < count; index++) {
      await control.command('select', testId(`template-role-main-role-${index}`), {
        by: 'label',
        value: '当前设备智能体',
      })
    }
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      const definitions = JSON.parse(
        await readFile(
          new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
          'utf8'
        )
      )
      const document = structuredClone(definitions[0])
      document.metadata = { namespace: 'default', name: `collaboration-e2e-${process.pid}` }
      document.spec.displayName = `Shared workflow ${process.pid}`
      source = await request(`/api/v1/collaboration-templates/${document.metadata.name}`, 'PUT', {
        document,
        expectedRevision: null,
      })
      assert.equal(source.document.kind, 'Template')
      assert.equal(source.document.spec.category, 'collaboration')
      const repeated = await request(
        `/api/v1/collaboration-templates/${document.metadata.name}`,
        'PUT',
        { document, expectedRevision: null }
      )
      assert.equal(repeated.id, source.id, 'Saving the same identity duplicated a Kind')
      const password = `template-test-${process.pid}`
      const username = `template-consumer-${process.pid}`
      await request('/api/admin/users', 'POST', {
        user_name: username,
        password,
        role: 'user',
        auth_source: 'password',
      })
      consumerToken = (await request('/api/auth/login', 'POST', { user_name: username, password }))
        .access_token
      await request(
        `/api/v1/collaboration-templates/${source.id}`,
        'GET',
        undefined,
        consumerToken,
        404
      )
      const privateList = await request(
        '/api/v1/collaboration-templates',
        'GET',
        undefined,
        consumerToken
      )
      assert.ok(!privateList.items.some(item => item.id === source.id))
      await request('/api/resource-library/listings', 'POST', {
        resource_type: 'template',
        source_id: source.id,
        display_name: document.spec.displayName,
        version: document.spec.version,
        status: 'published',
      })
      for (let index = 0; index < 2; index++)
        await request(
          `/api/resource-library/listings/${source.id}/install`,
          'POST',
          { target_namespace: 'default' },
          consumerToken
        )
      const installed = await request(
        '/api/v1/collaboration-templates',
        'GET',
        undefined,
        consumerToken
      )
      assert.ok(
        installed.items.some(item => item.id === source.id),
        'Reference installation is absent from the shared library'
      )
      const updated = structuredClone(document)
      updated.spec.version = '2.0.0'
      await request(
        `/api/v1/collaboration-templates/${document.metadata.name}`,
        'PUT',
        { document: updated, expectedRevision: 'stale' },
        cloud.authToken,
        409
      )
      const latest = await request(
        `/api/v1/collaboration-templates/${document.metadata.name}`,
        'PUT',
        { document: updated, expectedRevision: source.revision }
      )
      assert.equal(latest.id, source.id)
      assert.notEqual(latest.revision, source.revision)
      const listings = await request(
        `/api/resource-library/listings?resource_type=template&keyword=${encodeURIComponent(document.spec.displayName)}`,
        'GET',
        undefined,
        consumerToken
      )
      assert.equal(
        listings.items.find(item => item.id === source.id)?.current_version.version,
        '2.0.0'
      )
      const read = await request(
        `/api/v1/collaboration-templates/${source.id}`,
        'GET',
        undefined,
        consumerToken
      )
      assert.equal(read.document.spec.version, '2.0.0')
      await request(
        `/api/resource-library/listings/${source.id}/publication`,
        'PUT',
        { version: '3.0.0' },
        cloud.authToken,
        409
      )
      const invalid = structuredClone(updated)
      invalid.spec.resources.collaboration.credentials = { token: 'not-a-real-secret' }
      await request(
        `/api/v1/collaboration-templates/${document.metadata.name}`,
        'PUT',
        { document: invalid, expectedRevision: latest.revision },
        cloud.authToken,
        422
      )
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await wait(control, 'collaboration-platform-root')
      await click(control, 'collaboration-primary-templates')
      await wait(control, 'template-card-product-lifecycle', '产品全流程')
      await capture(control, '01-discover')
      await click(control, 'template-details-product-lifecycle')
      await wait(control, 'collaboration-template-preview', '发布交付')
      await capture(control, '02-preview')
      await click(control, 'template-use')
      await wait(control, 'project-create-template-section')
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            testId('collaboration-project-create-confirm') + ':disabled'
          )
        ),
        1,
        'Unbound roles did not block project creation'
      )
      await fillRoles(control, 6)
      await control.command('fill', testId('collaboration-project-name-input'), {
        value: projectName,
      })
      await capture(control, '03-create-bindings')
      await control.command('clickWhenEnabled', testId('collaboration-project-create-confirm'), {
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, 'cloud-project-header-title', projectName)
      await click(control, 'collaboration-tab-manage')
      await click(control, 'collaboration-project-settings-sharing')
      await wait(control, 'project-template-settings')
      await capture(control, '04-sharing-settings')
      await click(control, 'project-template-save')
      await control.command('fill', testId('template-save-name'), { value: savedName })
      await click(control, 'template-save-confirm')
      await wait(control, 'collaboration-template-dialog', '已保存到我的模板')
      await capture(control, '05-saved')
      const mine = await request('/api/v1/collaboration-templates')
      const saved = mine.items.find(item => item.displayName === savedName)
      assert.ok(saved, 'Desktop save did not reach the real Kind-backed API')
      const savedDefinition = await request(`/api/v1/collaboration-templates/${saved.id}`)
      assert.equal(savedDefinition.document.spec.resources.collaboration.groups.length, 1)
      await click(control, 'template-publish')
      await wait(control, 'collaboration-template-dialog', '其他人可以')
      await capture(control, '06-publish-confirm')
      await click(control, 'template-publish')
      await wait(control, 'collaboration-template-dialog', '模板已发布')
      await capture(control, '07-published')
      await click(control, 'template-save-close')
      await click(control, 'project-template-import')
      await click(control, 'template-details-research-analysis')
      await click(control, 'template-use')
      await fillRoles(control, 3)
      await capture(control, '08-import-bindings')
      await control.command('clickWhenEnabled', testId('template-bindings-apply'), {
        timeoutMs: uiTimeoutMs,
      })
      await click(control, 'collaboration-project-settings-groups')
      await wait(control, 'collaboration-project-groups-page', '调研分析小组')
      await wait(control, 'collaboration-project-groups-page', '产品全流程小组')
      await capture(control, '09-imported-groups')
      await reloadMainWindow(control, 'Template-created project did not reload')
      await wait(control, 'cloud-project-header-title', projectName)
      await click(control, 'collaboration-tab-manage')
      await click(control, 'collaboration-project-settings-groups')
      await wait(control, 'collaboration-project-groups-page', '调研分析小组')
      await capture(control, '10-persisted')
      await click(control, 'collaboration-group-open-create')
      await click(control, 'group-template-create')
      await click(control, 'template-details-content-creation')
      await click(control, 'template-use')
      await fillRoles(control, 3)
      await control.command('clickWhenEnabled', testId('template-bindings-apply'), {
        timeoutMs: uiTimeoutMs,
      })
      await wait(control, 'collaboration-group-detail-name')
      assert.equal(
        await control.command('getValue', testId('collaboration-group-detail-name')),
        '内容创作小组'
      )
      await capture(control, '11-group-created-from-template')
    },
  }
}
