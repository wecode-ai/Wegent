import assert from 'node:assert/strict'
import { mkdir, realpath, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { openCollaborationNotifications } from './stand-in-flows.mjs'

export async function verifyStandInWorkspaceRecovery({
  request,
  rpc,
  project,
  user,
  until,
  control,
  resultDir,
}) {
  const projectKey = 'stand-in-workspace-recovery'
  const original = join(resultDir, 'stand-in-original-workspace')
  const relocated = join(resultDir, 'stand-in-relocated-workspace')
  await mkdir(original)
  const saveProject = async path => {
    const saved = await rpc('runtime.projects.upsert_local', {
      projectKey,
      name: 'Stand-in workspace recovery',
      roots: [path],
      runtime: 'codex',
    })
    assert.equal(saved.success, true, JSON.stringify(saved))
    assert.equal(saved.projectKey, projectKey)
  }
  await saveProject(original)
  const personal = await rpc('runtime.stand_in.personal.get', { userId: user.id })
  const role = personal.roles.find(row => row.id === 'recovery-reviewer')
  assert.ok(role)
  const saved = await rpc('runtime.stand_in.personal.save', {
    userId: user.id,
    settings: {
      ...personal,
      roles: personal.roles.map(row =>
        row.id === role.id
          ? {
              ...row,
              workspace: { projectKey, executionMode: 'current_workspace' },
              collaboration: {
                ...row.collaboration,
                policy: { automatic: true, immediate: true, askBeforeAct: false },
              },
            }
          : row
      ),
    },
  })
  assert.deepEqual(saved.roles.find(row => row.id === role.id).workspace, {
    projectKey,
    executionMode: 'current_workspace',
  })
  await rename(original, relocated)
  const issue = await request(`/v1/cloud-projects/${project.id}/loop-items`, {
    title: 'Recover assistant startup after moving the project root',
    assignee_user_id: user.id,
  })
  const getFailures = async () =>
    (await request('/v1/wework-notifications?category=collaboration')).items.filter(
      row => row.payload.itemId === issue.id && row.payload.action === 'stand_in_start_failed'
    )
  const [notice] = await until(
    getFailures,
    rows => rows.length > 0,
    'Automatic startup rejection must create an inbox notification'
  )
  assert.equal(notice.payload.failureCode, 'workspace_unavailable')
  assert.equal(notice.read_at, null)
  assert.deepEqual(await request(`/v1/loop-items/${issue.id}/tasks`), [])
  const alertUrl = `wework://boards/${project.id}/issues/${issue.id}`
  await until(
    async () => JSON.parse(await control.command('getSystemNotifications', 'body')),
    alerts => alerts.some(alert => alert.url === alertUrl && alert.title.includes(issue.title)),
    'Startup rejection must send a desktop notification for the Issue'
  )
  const inbox = '[data-testid="wework-notifications-popover"]'
  if (Number(await control.command('getElementCount', inbox, { visible: true })) === 0)
    await openCollaborationNotifications(control)
  else
    await control.command(
      'clickWhenEnabled',
      '[data-testid="wework-notifications-category-collaboration"]'
    )
  await control.command('waitFor', `[data-testid="wework-notification-${notice.id}-body"]`)

  await saveProject(relocated)
  const retry = await rpc('runtime.stand_in.run', {
    projectId: String(project.id),
    issueId: issue.id,
    userId: user.id,
    projectStore: 'cloud',
    standInId: role.id,
  })
  const completed = await until(
    () => rpc('runtime.tasks.get', { taskId: retry.taskId }),
    result => result.task?.status === 'done',
    'The original assistant settings must run in the newly registered project root'
  )
  assert.equal(await realpath(completed.task.workspacePath), await realpath(relocated))
  assert.equal((await getFailures()).length, 1)
}
