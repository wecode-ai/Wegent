import { revealCollaborationSidebarElement } from './collaboration-sidebar-navigation.mjs'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { reloadMainWindow } from './workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const selector = name => `${CONTENT} [data-testid="${name}"]`

export async function verifyTemplateDeletionPermissions({ request, source, consumerToken }) {
  // A private template's numeric id must not allow a different account to delete it.
  await request(`/api/v1/collaboration-templates/${source.id}`, 'DELETE', undefined, consumerToken)
  assert.equal((await request(`/api/v1/collaboration-templates/${source.id}`)).id, source.id)
  const builtin = (await request('/api/v1/collaboration-templates')).items.find(
    item => item.ownerId === 0
  )
  assert.ok(builtin, 'The template deletion fixture requires a system template')
  await request(`/api/v1/collaboration-templates/${builtin.id}`, 'DELETE')
  assert.equal((await request(`/api/v1/collaboration-templates/${builtin.id}`)).id, builtin.id)
  await request(`/api/v1/collaboration-templates/${source.id}`, 'DELETE', undefined, '', 401)
}

/** Imported templates can be cancelled or deleted without changing built-in templates. */
export async function verifyTemplateDeletion(control, { request, captureScreenshot }) {
  const definitions = JSON.parse(
    await readFile(
      new URL('../../../../shared/data/collaboration-templates.json', import.meta.url),
      'utf8'
    )
  )
  const document = structuredClone(definitions[0])
  document.spec.displayName = `待删除的导入模板-${process.pid}`
  await revealCollaborationSidebarElement(control, selector('collaboration-primary-templates'))
  await control.command('click', selector('collaboration-primary-templates'))
  await control.command('click', selector('template-import-open'))
  await control.command('selectFile', selector('template-import-file'), {
    filename: 'imported.yaml',
    mimeType: 'application/yaml',
    value: Buffer.from(JSON.stringify(document)).toString('base64'),
  })
  await control.command('clickWhenEnabled', selector('template-import-save'))
  await control.command('waitFor', selector('collaboration-template-dialog'), { visible: false })
  const mine = await request('/api/v1/collaboration-templates')
  const imported = mine.items.find(item => item.displayName === document.spec.displayName)
  assert.ok(imported, 'YAML import did not persist the personal template')
  const deleteSelector = selector(`template-delete-${imported.name}`)
  const cardSelector = selector(`template-card-${imported.name}`)
  await control.command('waitFor', cardSelector)
  await control.command('click', deleteSelector)
  await control.command('waitFor', selector('collaboration-template-dialog'), {
    text: document.spec.displayName,
  })
  await control.command('click', selector('template-delete-cancel'))
  await control.command('waitFor', cardSelector)
  assert.ok(
    (await request('/api/v1/collaboration-templates')).items.some(item => item.id === imported.id)
  )
  await control.command('click', deleteSelector)
  await captureScreenshot(control, 'template-delete-confirm.png', CONTENT)
  await control.command('clickWhenEnabled', selector('template-delete-confirm'))
  await control.command('waitFor', cardSelector, { visible: false })
  assert.ok(
    !(await request('/api/v1/collaboration-templates')).items.some(item => item.id === imported.id)
  )
  await request(`/api/v1/collaboration-templates/${imported.id}`, 'GET', undefined, undefined, 404)
  await request(`/api/v1/collaboration-templates/${imported.id}`, 'DELETE')
  await reloadMainWindow(control, 'Deleted template must stay deleted after reload')
  await revealCollaborationSidebarElement(control, selector('collaboration-primary-templates'))
  await control.command('waitFor', selector('collaboration-primary-templates'))
  await revealCollaborationSidebarElement(control, selector('collaboration-primary-templates'))
  await control.command('click', selector('collaboration-primary-templates'))
  await control.command('waitFor', selector('collaboration-template-page'))
  await control.command('click', selector('template-tab-mine'))
  assert.equal(Number(await control.command('getElementCount', cardSelector)), 0)
  await control.command('click', selector('template-tab-discover'))
  await control.command('waitFor', selector('template-card-product-lifecycle'))
  assert.equal(
    Number(await control.command('getElementCount', selector('template-delete-product-lifecycle'))),
    0
  )
  await captureScreenshot(control, 'template-delete-persisted.png', CONTENT)
}
