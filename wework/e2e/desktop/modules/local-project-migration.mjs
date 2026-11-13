import assert from 'node:assert/strict'
import { requestExecutor } from './executor-rpc.mjs'
import {
  reloadMainWindow,
  inCollaborationSidebar,
  revealCollaborationSidebarElement,
} from './workspace-flows.mjs'

/** A real Native project migrates shared content through Backend without moving Runtime storage. */
export async function verifyLocalProjectMigration(control, request, timeoutMs) {
  const rpc = (method, params) => requestExecutor(control, method, params, timeoutMs)
  const name = `Migrate shared content ${process.pid}`
  const source = await rpc('projects.create', { name })
  const issue = await rpc('todos.create', {
    project_id: source.id,
    todo: { title: 'Migration parent' },
  })
  await rpc('todos.create', {
    project_id: source.id,
    todo: { title: 'Migration child', parent_id: issue.id },
  })
  await rpc('todos.comment', {
    project_id: source.id,
    task_id: issue.id,
    body: 'Public migration discussion',
  })
  const attachment = await rpc('attachments.add', {
    project_id: source.id,
    item_id: issue.id,
    file: {
      display_name: 'migration.txt',
      content_type: 'text/plain',
      base64: Buffer.from('shared file bytes').toString('base64'),
    },
  })
  const before = await rpc('todos.bindings', { task_id: issue.id })
  await reloadMainWindow(control, 'Migration source did not appear')
  const convert = inCollaborationSidebar(
    `[data-testid="collaboration-project-convert-${source.id}"]`
  )
  await revealCollaborationSidebarElement(control, convert)
  await control.command('click', convert)
  await control.command('waitFor', '[data-testid="local-project-migration-dialog"]')
  await control.command('clickWhenEnabled', '[data-testid="local-project-migration-confirm"]')
  await control.command('waitFor', '[data-testid="local-project-migration-dialog"]', {
    visible: false,
    timeoutMs,
  })
  const projects = await request('/api/v1/cloud-projects')
  const target = projects.items.find(project => project.name === name)
  assert.ok(target, 'Migration must persist a cloud project')
  const issues = await request(`/api/v1/cloud-projects/${target.id}/loop-items`)
  const parent = issues.items.find(item => item.title === 'Migration parent')
  const child = issues.items.find(item => item.title === 'Migration child')
  assert.ok(parent)
  assert.equal(child.parent_id, parent.id)
  const comments = await request(
    `/api/v1/cloud-projects/${target.id}/loop-items/${parent.id}/activity-comments`
  )
  assert.ok(comments.some(comment => comment.body.includes('Public migration discussion')))
  const files = await request(`/api/v1/loop-items/${parent.id}/attachments`)
  assert.equal(files.length, 1)
  assert.equal(files[0].display_name, 'migration.txt')
  assert.notEqual(files[0].id, attachment.id)
  const sourceSnapshot = await rpc('projects.migration_snapshot', { project_id: source.id })
  assert.equal(sourceSnapshot.archived, true)
  assert.equal(sourceSnapshot.migration_target, String(target.id))
  assert.deepEqual(await rpc('todos.bindings', { task_id: issue.id }), before)
  const originalComments = await rpc('todos.comment.list', {
    project_id: source.id,
    task_id: issue.id,
  })
  assert.ok(
    originalComments.some(comment => comment.content.includes('Public migration discussion'))
  )
}
