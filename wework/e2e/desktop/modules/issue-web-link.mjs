import assert from 'node:assert/strict'

const BUTTON =
  '[data-workspace-tab-content][aria-hidden="false"] [data-testid="issue-copy-web-link"]'

/** A cloud Issue shares its Wegent website address through the native clipboard. */
export async function verifyIssueWebLink(control, { request, project, issue }) {
  const config = await request('/api/auth/wework/config')
  assert.ok(config.web_url, 'The connected Backend must advertise its Wegent website')
  const workspacePath = project.workspace_id
    ? `/collaboration/workspaces/${encodeURIComponent(project.workspace_id)}/projects/${encodeURIComponent(project.id)}`
    : `/collaboration/${encodeURIComponent(project.id)}`
  await control.command('clickWhenEnabled', BUTTON)
  await control.command('waitFor', BUTTON, { text: '已复制' })
  assert.equal(
    await control.command('getClipboardText', ''),
    `${config.web_url.replace(/\/+$/, '')}${workspacePath}/issues/${encodeURIComponent(issue.id)}`,
    'Copying an Issue must write its Wegent website address to the native clipboard'
  )
  const persisted = await request(`/api/v1/loop-items/${issue.id}`)
  assert.equal(persisted.id, issue.id)
  assert.equal(String(persisted.cloud_project_id), String(project.id))
}

export async function verifyLocalIssueHasNoWebLink(control) {
  await control.command('waitFor', BUTTON, { visible: false })
}
