import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  waitForCompletedRuntimeTaskThread,
  waitForRunningRuntimeTask,
} from './runtime-task-evidence.mjs'
import { waitForValue } from './workspace-agent-setup.mjs'

export async function verifyCollaborationExpNotificationTab({
  control,
  conversation,
  appSelector,
  tabSelector,
  click,
  uiTimeoutMs,
}) {
  const query = async () => {
    const snapshot = JSON.parse(await control.command('snapshot', appSelector))
    const params = new URL(snapshot.location).searchParams
    params.delete('workspaceTab')
    params.delete('workspaceTabTitle')
    return [...params].sort(([left], [right]) => left.localeCompare(right))
  }
  const original = await query()
  let pendingTab
  let tabCount
  for (const requestKey of ['experiment-navigation-first', 'experiment-navigation-second']) {
    await control.command('activateSystemNotification', 'body', {
      value: `wework://interactions/${encodeURIComponent(conversation.deviceId)}/${encodeURIComponent(conversation.taskId)}/${requestKey}`,
    })
    await waitForValue(
      () => control.command('getRoute', 'body'),
      value => value === '/pending-interactions' && value,
      'The native interaction notification must leave the experiment tab',
      uiTimeoutMs
    )
    await control.command('waitFor', `${tabSelector}[aria-selected="false"]`)
    const [selected] = JSON.parse(
      await control.command(
        'getElementMetrics',
        '[role="tab"][aria-selected="true"][data-testid^="workspace-tab-select-"]'
      )
    )
    assert.ok(
      selected?.testId && selected.testId !== 'workspace-tab-select-fixed-collaboration-exp'
    )
    if (pendingTab) assert.equal(selected.testId, pendingTab)
    pendingTab = selected.testId
    const tabs = JSON.parse(await control.command('snapshot', 'body')).testIds.filter(id =>
      id.startsWith('workspace-tab-select-')
    )
    assert.equal(tabs.filter(id => id === 'workspace-tab-select-fixed-collaboration-exp').length, 1)
    if (tabCount) assert.equal(tabs.length, tabCount, 'Repeated notifications must reuse one tab')
    tabCount = tabs.length
    await click(control, tabSelector)
    await control.command('waitFor', `${tabSelector}[aria-selected="true"]`)
    await control.command('waitFor', appSelector, { visible: true })
    assert.deepEqual(await query(), original, 'The original experiment query must be retained')
  }
}

export async function verifyCollaborationExpIssueCreateAndEdit({
  control,
  localProject,
  cloudProject,
  cloudUser,
  rpc,
  request,
  captureScreenshot,
  resultDir,
  uiTimeoutMs,
  appSelector: APP,
  testId,
  click,
}) {
  const createLogPath = join(resultDir, 'app.log')
  const createLogOffset = (await readFile(createLogPath, 'utf8')).length
  for (const [store, project] of [
    ['local', localProject],
    ['backend', cloudProject],
  ]) {
    await control.command('navigate', 'body', {
      value: `/collaboration-exp?view=tasks&relevance=all&projectStore=${store}&projectId=${project.id}&future=keep`,
    })
    const targetProjectId = store === 'local' ? 'default-work-items' : project.id
    const listIssues = async () =>
      store === 'local'
        ? rpc('todos.list', { project_id: targetProjectId })
        : (await request(`/api/v1/cloud-projects/${targetProjectId}/loop-items`)).items
    const beforeCreate = await listIssues()
    await click(control, testId('collaboration-exp-task-create'))
    await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
      visible: true,
    })
    await control.command('fill', testId('collaboration-exp-create-goal'), {
      value: `COLLABORATION_EXP_CANCELLED_${store}`,
    })
    await click(control, testId('collaboration-exp-create-cancel'))
    await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
      visible: false,
    })
    assert.deepEqual(await listIssues(), beforeCreate, 'Cancel must perform no Issue write')

    const title = `COLLABORATION_EXP_CREATED_${store}_${process.pid}`
    await click(control, testId('collaboration-exp-task-create'))
    if (store === 'backend') {
      await click(control, testId('collaboration-exp-create-project'))
      await click(
        control,
        `[data-testid=${JSON.stringify(`collaboration-exp-create-project-option-${JSON.stringify([store, project.id])}`)}]`
      )
    }
    await control.command('fill', testId('collaboration-exp-create-goal'), { value: title })
    await control.command('fill', testId('collaboration-exp-create-summary'), {
      value: `Persisted through the real ${store} source`,
    })
    await captureScreenshot(control, `collaboration-exp-create-${store}.png`, APP)
    await click(control, testId('collaboration-exp-create-submit'))
    await control.command('waitFor', testId('collaboration-exp-create-dialog'), {
      visible: false,
    })
    const created = await waitForValue(
      listIssues,
      issues => issues.find(issue => issue.title === title),
      'The Demo create action must persist through its exact real source',
      uiTimeoutMs
    )
    assert.equal(created.cloud_project_id, targetProjectId)
    assert.equal(created.assignee_user_id, store === 'local' ? 0 : cloudUser.id)
    assert.equal(created.description, `Persisted through the real ${store} source`)
    assert.equal((await listIssues()).filter(issue => issue.title === title).length, 1)
    await control.command('waitFor', testId('collaboration-exp-pane-header-timeline'), {
      text: title,
    })
    const params = new URL(JSON.parse(await control.command('snapshot', APP)).location).searchParams
    assert.equal(params.get('projectStore'), store)
    assert.equal(params.get('projectId'), created.cloud_project_id)
    assert.equal(params.get('issueId'), created.id)
    await click(control, testId('collaboration-exp-header-details'))
    await control.command('waitFor', testId('collaboration-exp-issue-summary'), {
      visible: true,
      text: created.description,
    })
    await captureScreenshot(control, `collaboration-exp-summary-${store}.png`, APP)
    await click(control, testId('collaboration-exp-issue-summary-configure'))
    const detailTitle = testId('cloud-todo-detail-title')
    await control.command('waitFor', detailTitle, { visible: true })
    assert.equal(await control.command('getValue', detailTitle), title)
    await captureScreenshot(control, `collaboration-exp-details-${store}.png`, APP)
    await control.command('fill', detailTitle, { value: `${title}_EDITED` })
    await control.command('press', detailTitle, { key: 'Enter' })
    const edited = await waitForValue(
      listIssues,
      issues => issues.find(issue => issue.id === created.id && issue.title === `${title}_EDITED`),
      'The existing native editor must save the same canonical Issue',
      uiTimeoutMs
    )
    assert.equal(edited.id, created.id)
    assert.ok(edited.version > created.version)
    await control.command('waitFor', testId('collaboration-exp-pane-header-timeline'), {
      text: edited.title,
    })
    await click(control, testId('collaboration-exp-pane-header-issue-details-back'))
    await control.command('waitFor', testId('collaboration-exp-issue-details'), {
      visible: false,
    })
    assert.equal((await listIssues()).filter(issue => issue.id === created.id).length, 1)
    if (store === 'backend') {
      await request(`/api/v1/loop-items/${created.id}`, undefined, { method: 'DELETE' })
      assert.equal(
        (await listIssues()).some(issue => issue.id === created.id),
        false
      )
    }
  }
  assert.doesNotMatch(
    (await readFile(createLogPath, 'utf8')).slice(createLogOffset),
    /\[renderer-(?:warning|error)\]/,
    'Real create, cancel and native Issue detail operations must emit no renderer warnings or errors'
  )
}

export async function verifyCollaborationExpPrivateMessage({
  control,
  conversation,
  localIssue,
  cloudIssue,
  cloudProject,
  nativeTaskIdentities,
  rpc,
  request,
  comments,
  privateInput: PRIVATE_INPUT,
  privateMessage: PRIVATE_MESSAGE,
  click,
  testId,
  uiTimeoutMs,
  modelResponseTimeoutMs,
  hasHeldPrivateResponse,
  finishPrivateResponse,
}) {
  const beforePrivateTasks = await nativeTaskIdentities()
  const privateThread = await waitForCompletedRuntimeTaskThread(
    control,
    conversation.taskId,
    uiTimeoutMs
  )
  const beforePrivateLocal = await rpc('todos.get', { task_id: localIssue.id })
  const beforePrivateCloud = await request(`/api/v1/loop-items/${cloudIssue.id}`)
  const beforePrivateComments = await comments()
  const beforePrivateCloudComments = await request(
    `/api/v1/cloud-projects/${cloudProject.id}/loop-items/${cloudIssue.id}/activity-comments`
  )
  const assertPrivateLeavesSharedUnchanged = async () => {
    assert.equal(
      (await rpc('todos.get', { task_id: localIssue.id })).status,
      beforePrivateLocal.status
    )
    assert.equal(
      (await request(`/api/v1/loop-items/${cloudIssue.id}`)).status,
      beforePrivateCloud.status
    )
    assert.deepEqual(await comments(), beforePrivateComments)
    assert.deepEqual(
      await request(
        `/api/v1/cloud-projects/${cloudProject.id}/loop-items/${cloudIssue.id}/activity-comments`
      ),
      beforePrivateCloudComments
    )
  }
  await control.command('fill', PRIVATE_INPUT, { value: PRIVATE_MESSAGE })
  await click(
    control,
    `${testId('collaboration-exp-private-conversation')} [data-testid="send-message-button"]`
  )
  await waitForRunningRuntimeTask(
    async taskId => {
      const response = await rpc('runtime.tasks.get', { taskId })
      assert.equal(response.success, true)
      return response.task
    },
    conversation.taskId,
    modelResponseTimeoutMs
  )
  await waitForValue(
    async () => Boolean(hasHeldPrivateResponse()),
    Boolean,
    'The real private turn must reach the held model response',
    modelResponseTimeoutMs
  )
  await assertPrivateLeavesSharedUnchanged()
  finishPrivateResponse()
  await control.command('waitFor', testId('collaboration-exp-private-conversation'), {
    text: `${PRIVATE_MESSAGE}_COMPLETE`,
    timeoutMs: modelResponseTimeoutMs,
  })
  assert.equal(
    await waitForCompletedRuntimeTaskThread(control, conversation.taskId, uiTimeoutMs),
    privateThread,
    'Private discussion must continue the same original native thread'
  )
  assert.deepEqual(await nativeTaskIdentities(), beforePrivateTasks)
  await assertPrivateLeavesSharedUnchanged()
}
