import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'
import {
  createLocalCollaborationProject,
  configureFirstProjectExecutionEnvironment,
  reloadMainWindow,
  selectCollaborationDomain,
  selectCollaborationProjectView,
} from '../modules/workspace-flows.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = testId => `${CONTENT} [data-testid="${testId}"]`

async function selectMilestone(control, value, testId = 'issue-milestone') {
  await control.command('clickWhenEnabled', scoped(testId))
  await control.command('clickWhenEnabled', `[data-testid="${testId}-option-${value || 'empty'}"]`)
}

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let cloud
  let workspace
  let project
  let milestone
  let issue
  const request = async (path, method = 'GET', body, expectedStatus, token = cloud.authToken) => {
    const response = await fetch(`${cloud.backendUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (expectedStatus === undefined) {
      assert.equal(response.ok, true, `${method} ${path}: ${response.status} ${text}`)
    } else {
      assert.equal(response.status, expectedStatus, `${method} ${path}: ${text}`)
    }
    return text ? JSON.parse(text) : null
  }
  const openMilestones = async control => {
    await selectCollaborationProjectView(control, CONTENT, 'milestones', uiTimeoutMs)
    await control.command('waitFor', scoped('milestones-page'), { timeoutMs: uiTimeoutMs })
  }
  const deleteMilestone = async (control, id) => {
    await control.command('clickWhenEnabled', scoped(`milestone-delete-${id}`))
    await captureScreenshot(control, `milestones-delete-confirm-${id}.png`, 'body')
    await control.command('click', scoped('milestone-delete-cancel'))
    await control.command('waitFor', scoped(`milestone-${id}`))
    await control.command('clickWhenEnabled', scoped(`milestone-delete-${id}`))
    await control.command('clickWhenEnabled', scoped('milestone-delete-confirm'))
    await control.command('waitFor', scoped(`milestone-${id}`), {
      visible: false,
      timeoutMs: uiTimeoutMs,
    })
  }
  const bulkMilestone = async (control, id) => {
    await selectCollaborationProjectView(control, CONTENT, 'table')
    await control.command('waitFor', scoped('collaboration-issue-table'))
    const unchecked = `${scoped('collaboration-issue-table-select-all')}:not(:checked)`
    if (Number(await control.command('getElementCount', unchecked)) > 0) {
      await control.command('click', unchecked)
    }
    await control.command('waitFor', `${scoped('milestone-bulk-select')}:enabled`)
    await selectMilestone(control, id ?? '', 'milestone-bulk-select')
    await control.command('clickWhenEnabled', scoped('milestone-bulk-apply'))
    await control.command('waitFor', `${scoped('milestone-bulk-apply')}:enabled`)
  }
  const assertCompactActions = async (control, table = false) => {
    await waitForValue(
      async () => ({
        header: JSON.parse(
          await control.command('getElementMetrics', scoped('cloud-project-header'))
        )[0],
        actions: JSON.parse(
          await control.command('getElementMetrics', scoped('cloud-project-header-actions'))
        )[0],
      }),
      ({ header, actions }) => actions.left >= header.left && actions.right <= header.right + 1,
      'Project actions must fit the header after responsive layout settles',
      uiTimeoutMs
    )
    const selectors = [`${scoped('cloud-project-header-actions')} button`]
    if (table) selectors.push(`${scoped('collaboration-issue-table-batch')} button`)
    for (const selector of selectors) {
      const metrics = JSON.parse(await control.command('getElementMetrics', selector))
      const visible = metrics.filter(item => item.width > 0 && item.height > 0)
      assert.ok(visible.length > 0, `Expected visible actions: ${selector}`)
      for (const item of visible) {
        assert.ok(item.height <= 44, `Action text must stay on one line: ${JSON.stringify(item)}`)
        assert.ok(
          item.scrollHeight <= item.clientHeight + 1,
          'Action text must not overflow vertically'
        )
        assert.ok(
          item.scrollWidth <= item.clientWidth + 1,
          'Action text must not overflow horizontally'
        )
      }
    }
    if (table) {
      const [count] = JSON.parse(
        await control.command(
          'getElementMetrics',
          `${scoped('collaboration-issue-table-batch')} strong`
        )
      )
      assert.ok(count.height <= 24, 'The selection count must stay on one line')
    }
  }

  const style = (control, selector, property) =>
    control.command('getComputedStyleValue', selector, { value: property })
  const assertProgress = async (control, id, percent) => {
    const track = `${scoped(`milestone-${id}`)} [role="progressbar"]`
    assert.equal(
      await control.command('getAttribute', track, { value: 'aria-valuenow' }),
      String(percent)
    )
    const [fill] = JSON.parse(
      await control.command('getElementMetrics', scoped(`milestone-progress-fill-${id}`))
    )
    const [bar] = JSON.parse(await control.command('getElementMetrics', track))
    assert.ok(
      Math.abs(fill.width - (bar.width * percent) / 100) <= 1,
      `Wrong ${percent}% fill: ${JSON.stringify({ fill, bar })}`
    )
  }
  const assertToolbarTypography = async control => {
    const controls = [
      scoped('cloud-board-group-by'),
      scoped('cloud-board-group-filter-label'),
      scoped('milestone-filter'),
      scoped('cloud-board-search'),
      scoped('cloud-board-parent-layout'),
    ]
    for (const property of ['font-family', 'font-size', 'font-weight', 'line-height']) {
      const expected = await style(control, controls[0], property)
      for (const selector of controls.slice(1))
        assert.equal(
          await style(control, selector, property),
          expected,
          `Toolbar ${property} differs: ${selector}`
        )
    }
    await control.command('nativePress', scoped('cloud-board-search'), { key: 'Shift+Tab' })
    await control.command('waitFor', `${scoped('milestone-filter')}:focus-visible`)
    const filterShell = `${CONTENT} .milestone-picker-filter`
    assert.equal(await style(control, filterShell, 'outline-style'), 'solid')
    assert.ok(parseFloat(await style(control, filterShell, 'outline-width')) >= 2)
  }
  const assertFormStates = async control => {
    await control.command('focus', scoped('milestone-title'))
    assert.equal(await style(control, scoped('milestone-title'), 'border-top-style'), 'solid')
    assert.ok(parseFloat(await style(control, scoped('milestone-title'), 'border-top-width')) >= 1)
    assert.notEqual(
      await style(control, scoped('milestone-title'), 'border-top-color'),
      'rgba(0, 0, 0, 0)'
    )
    const text = await style(control, scoped('milestone-save'), 'color')
    await control.command('hover', scoped('milestone-save'))
    assert.equal(await style(control, scoped('milestone-save'), 'color'), text)
    const foreground = text.match(/[\d.]+/g)?.map(Number)
    const background = (await style(control, scoped('milestone-save'), 'background-color'))
      .match(/[\d.]+/g)
      ?.map(Number)
    const surface = (await style(control, 'body', 'background-color')).match(/[\d.]+/g)?.map(Number)
    assert.ok(
      foreground?.length >= 3 && background?.length >= 3 && surface?.length >= 3,
      'Expected RGB colors for primary action contrast'
    )
    const luminance = channels =>
      channels
        .slice(0, 3)
        .map(value => value / 255)
        .map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
        .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    const alpha = background[3] ?? 1
    const painted = background
      .slice(0, 3)
      .map((value, index) => value * alpha + surface[index] * (1 - alpha))
    const light = luminance(foreground),
      dark = luminance(painted)
    assert.ok(
      (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) >= 4.5,
      'Save hover must preserve readable contrast'
    )
  }

  return {
    requiresCloudEnvironment: true,
    async prepareCloud(environment) {
      cloud = environment
      await request('/api/admin/setup-complete', 'POST')
      workspace = await request('/api/v1/workspaces', 'POST', { name: `Milestones ${process.pid}` })
      project = await request('/api/v1/cloud-projects', 'POST', {
        workspace_id: workspace.id,
        name: 'Milestone lifecycle',
        task_provider: 'local',
      })
      const aliasPath = `/api/v1/cloud-projects/00${project.id}/milestones`
      const aliasMilestone = await request(aliasPath, 'POST', {
        title: 'Canonical project identity',
        state: 'open',
      })
      assert.equal(aliasMilestone.project_id, String(project.id))
      const aliasUpdated = await request(`${aliasPath}/${aliasMilestone.id}`, 'PATCH', {
        title: 'Canonical updated',
        state: 'closed',
        version: aliasMilestone.version,
      })
      assert.equal((await request(aliasPath))[0].title, 'Canonical updated')
      await request(`${aliasPath}/${aliasMilestone.id}`, 'DELETE', {
        version: aliasUpdated.version,
      })
      milestone = await request(`/api/v1/cloud-projects/${project.id}/milestones`, 'POST', {
        title: 'Cloud release',
        description: 'Shared delivery goal',
        due_on: '2027-01-01',
        state: 'open',
      })
      const milestonePath = `/api/v1/cloud-projects/${project.id}/milestones/${milestone.id}`
      await request(
        milestonePath,
        'PATCH',
        { title: 'Stale update', version: milestone.version + 1 },
        409
      )
      await request(milestonePath, 'DELETE', { version: milestone.version + 1 }, 409)
      issue = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: 'Cloud milestone Issue',
        milestone_id: milestone.id,
        status: 'completed',
      })
      await request(`/api/v1/loop-items/${issue.id}`, 'DELETE')
      const archived = (await request(`/api/v1/cloud-projects/${project.id}/milestones`))[0]
      assert.equal(archived.closed_issues, 1)
      assert.equal(archived.archived_issues, 1)
      const userName = `milestones-viewer-${process.pid}`
      const password = 'milestones-e2e-fixture'
      const viewer = await request('/api/admin/users', 'POST', {
        user_name: userName,
        password,
        role: 'user',
        auth_source: 'password',
      })
      const login = await request('/api/auth/login', 'POST', { user_name: userName, password })
      await request(`/api/v1/cloud-projects/${project.id}/members`, 'POST', {
        user_id: viewer.id,
        role: 'Viewer',
      })
      const path = `/api/v1/cloud-projects/${project.id}/milestones`
      assert.equal(
        (await request(path, 'GET', undefined, 200, login.access_token))[0].closed_issues,
        1
      )
      await request(path, 'POST', { title: 'Forbidden' }, 403, login.access_token)
      await request(
        `${path}/${milestone.id}`,
        'PATCH',
        { title: 'Forbidden', version: milestone.version },
        403,
        login.access_token
      )
      await request(
        `${path}/${milestone.id}`,
        'DELETE',
        { version: milestone.version },
        403,
        login.access_token
      )
      const hidden = await request(`/api/v1/cloud-projects/${project.id}/loop-items`, 'POST', {
        title: 'Private delivery',
        status: 'completed',
        milestone_id: milestone.id,
      })
      const secured = await request(`/api/v1/loop-items/${hidden.id}`, 'PATCH', {
        version: hidden.version,
        security_level: 'related',
      })
      assert.equal((await request(path))[0].closed_issues, 2)
      assert.equal(
        (await request(path, 'GET', undefined, 200, login.access_token))[0].closed_issues,
        1
      )
      await request(`/api/v1/loop-items/${hidden.id}`, 'PATCH', {
        version: secured.version,
        status: 'pending',
      })
      await request(`/api/v1/loop-items/${hidden.id}`, 'DELETE')
      const archivedUnfinished = (await request(path))[0]
      assert.equal(archivedUnfinished.closed_issues, 1)
      assert.equal(archivedUnfinished.open_issues, 1)
      assert.equal(archivedUnfinished.archived_issues, 2)
      const visibleArchived = (await request(path, 'GET', undefined, 200, login.access_token))[0]
      assert.equal(visibleArchived.open_issues, 0)
      assert.equal(visibleArchived.archived_issues, 1)
      await request(`/api/v1/loop-items/${hidden.id}/restore`, 'POST')
      const restoredHidden = await request(`/api/v1/loop-items/${hidden.id}`)
      await request(`/api/v1/loop-items/${hidden.id}`, 'PATCH', {
        version: restoredHidden.version,
        milestone_id: null,
      })
      await request(`/api/v1/loop-items/${hidden.id}`, 'DELETE')
    },
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('openWeworkScheme', 'body', { value: `wework://boards/${project.id}` })
      await selectCollaborationProjectView(control, CONTENT, 'board', workbenchReadyTimeoutMs)
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${milestone.id}`), {
        text: '100%',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'milestones-01-cloud-archived-completion.png', 'body')
      await control.command('click', scoped(`milestone-open-${milestone.id}`))
      await control.command('waitFor', scoped('milestone-view-archive'))
      await captureScreenshot(control, 'milestones-02-cloud-archived-detail.png', 'body')
      await control.command('click', scoped('milestones-back'))
      await request(`/api/v1/loop-items/${issue.id}/restore`, 'POST')
      await reloadMainWindow(control, 'The restored cloud fixture must be loaded by the board')
      await selectCollaborationProjectView(control, CONTENT, 'board', workbenchReadyTimeoutMs)
      await control.command('waitFor', scoped(`cloud-todo-card-milestone-${issue.id}`), {
        text: 'Cloud release',
      })
      await control.command('scrollIntoView', scoped(`cloud-todo-card-milestone-${issue.id}`))
      await captureScreenshot(control, 'milestones-02b-cloud-card-metadata.png', 'body')
      await request(`/api/v1/loop-items/${issue.id}`, 'DELETE')
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${milestone.id}`), { text: '100%' })
      await assertProgress(control, milestone.id, 100)
      await control.command('clickWhenEnabled', scoped(`milestone-state-${milestone.id}`))
      await control.command('click', scoped('milestones-closed'))
      await control.command('waitFor', scoped(`milestone-${milestone.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      const closed = (await request(`/api/v1/cloud-projects/${project.id}/milestones`))[0]
      assert.equal(closed.state, 'closed')
      assert.equal(closed.closed_issues, 1)
      await captureScreenshot(control, 'milestones-03-cloud-closed.png', 'body')
      await control.command('clickWhenEnabled', scoped(`milestone-state-${milestone.id}`))
      await control.command('click', scoped('milestones-open'))
      await control.command('waitFor', scoped(`milestone-${milestone.id}`), {
        timeoutMs: uiTimeoutMs,
      })
      await deleteMilestone(control, milestone.id)
      await request(`/api/v1/loop-items/${issue.id}/restore`, 'POST')
      const preserved = await request(`/api/v1/loop-items/${issue.id}`)
      assert.equal(preserved.title, issue.title)
      assert.equal(preserved.milestone_id, null)

      await selectCollaborationDomain(control, CONTENT, 'local')
      await createLocalCollaborationProject(control, CONTENT, `Local milestones ${process.pid}`)
      const localProject = (await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)).find(
        candidate => candidate.name === `Local milestones ${process.pid}`
      )
      assert.ok(localProject)
      await configureFirstProjectExecutionEnvironment(control, CONTENT, uiTimeoutMs)
      await openMilestones(control)
      await control.command('waitFor', scoped('milestones-page'), { text: '暂无里程碑' })
      await captureScreenshot(control, 'milestones-04-local-empty.png', 'body')
      await control.command('click', scoped('milestone-create'))
      await control.command('fill', scoped('milestone-title'), { value: 'Local release' })
      await control.command('fill', scoped('milestone-description'), {
        value: `本地与云端统一的交付目标，归档后保持进度。\n${'LongUnbrokenDeliveryIdentifier'.repeat(12)}`,
      })
      await control.command('fill', scoped('milestone-due'), { value: '2027-01-01' })
      await assertFormStates(control)
      await captureScreenshot(control, 'milestones-05-local-form.png', 'body')
      await control.command('clickWhenEnabled', scoped('milestone-save'))
      const firstMilestone = `${CONTENT} [data-testid^="milestone-open-ms-"]`
      await control.command('waitFor', firstMilestone, {
        text: 'Local release',
        timeoutMs: uiTimeoutMs,
      })
      const localId = (
        await control.command('getAttribute', firstMilestone, { value: 'data-testid' })
      ).slice('milestone-open-'.length)
      await assertProgress(control, localId, 0)
      await control.command('click', scoped(`milestone-edit-${localId}`))
      await control.command('fill', scoped('milestone-title'), {
        value: 'Local release · 协作交付目标',
      })
      await control.command('clickWhenEnabled', scoped('milestone-save'))
      await control.command('waitFor', scoped(`milestone-open-${localId}`), {
        text: '协作交付目标',
      })
      await captureScreenshot(control, 'milestones-05c-local-edited.png', 'body')
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await control.command('clickWhenEnabled', scoped('collaboration-issue-create'))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`)
      await selectMilestone(control, localId)
      await control.command('fill', scoped('cloud-todo-title'), { value: 'Local milestone Issue' })
      await control.command('fill', scoped('cloud-todo-detail-description'), {
        value: 'Describe the local delivery scope before splitting it into child Issues.',
      })
      await control.command('click', scoped('cloud-todo-modal-close'))
      await control.command('clickWhenEnabled', scoped('collaboration-issue-create'))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`)
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        localId
      )
      const assigneeLabel = `${scoped('cloud-todo-create-assignee')} strong`
      assert.equal(await control.command('getText', assigneeLabel), '未指派')
      const [unassigned] = JSON.parse(await control.command('getElementMetrics', assigneeLabel))
      assert.ok(unassigned.scrollWidth <= unassigned.clientWidth + 1, 'Short assignee must fit')
      await captureScreenshot(control, 'milestones-05b-local-restored-draft.png', 'body')
      await control.command('click', scoped('cloud-todo-modal-close'))
      const localIssue = await createCollaborationBoardIssue(
        control,
        'Local milestone Issue',
        'completed',
        uiTimeoutMs
      )
      await control.command('click', scoped(`cloud-todo-card-${localIssue}`))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        localId
      )
      await selectMilestone(control, '')
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`, {
        timeoutMs: uiTimeoutMs,
      })
      await selectMilestone(control, localId)
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        localId
      )
      const [properties] = JSON.parse(
        await control.command('getElementMetrics', scoped('issue-title-properties'))
      )
      const [description] = JSON.parse(
        await control.command('getElementMetrics', `${CONTENT} .task-detail-workspace-description`)
      )
      const [children] = JSON.parse(
        await control.command('getElementMetrics', scoped('issue-hierarchy-summary'))
      )
      assert.ok(
        properties && description && children,
        'Expected properties, body and child section'
      )
      assert.ok(properties.bottom <= description.top + 1, 'Properties must precede the body')
      assert.ok(description.bottom <= children.top + 1, 'Child Issues must follow the body')
      await captureScreenshot(control, 'milestones-06-local-issue-assignment.png', 'body')
      await control.command('click', scoped('cloud-todo-detail-close'))
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${localId}`), {
        text: '100%',
        timeoutMs: uiTimeoutMs,
      })
      await captureScreenshot(control, 'milestones-07-local-progress.png', 'body')
      const windowSize = await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 900, height: 760 }),
      })
      await assertCompactActions(control)
      await captureScreenshot(control, 'milestones-07b-local-narrow.png', 'body')
      const [narrowPage] = JSON.parse(
        await control.command('getElementMetrics', scoped('milestones-page'))
      )
      assert.ok(
        narrowPage.scrollWidth <= narrowPage.clientWidth + 1,
        `Milestone content must fit the narrow window: ${JSON.stringify(narrowPage)}`
      )
      await control.command('setMainWindowSize', 'body', { value: windowSize })
      await control.command('click', scoped(`milestone-open-${localId}`))
      await control.command('waitFor', scoped('collaboration-issue-table'))
      await captureScreenshot(control, 'milestones-08-local-detail.png', 'body')
      await control.command('click', scoped('milestones-back'))
      await reloadMainWindow(control, 'Local milestones must survive reopening')
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${localId}`), {
        text: '100%',
        timeoutMs: uiTimeoutMs,
      })
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await control.command('hover', scoped(`collaboration-issue-${localIssue}`))
      await control.command('click', scoped(`cloud-todo-card-more-${localIssue}`))
      await control.command('click', scoped(`cloud-todo-card-archive-${localIssue}`))
      await control.command('clickWhenEnabled', scoped('collaboration-issue-archive-confirm'))
      await control.command('waitFor', scoped(`collaboration-issue-${localIssue}`), {
        visible: false,
      })
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${localId}`), { text: '100%' })
      await control.command('click', scoped(`milestone-open-${localId}`))
      await control.command('click', scoped('milestone-view-archive'))
      await control.command('waitFor', scoped(`collaboration-archived-issue-${localIssue}`))
      await captureScreenshot(control, 'milestones-08b-local-archived-completion.png', 'body')
      await control.command(
        'clickWhenEnabled',
        scoped(`collaboration-archived-issue-restore-${localIssue}`)
      )
      await control.command('waitFor', scoped(`collaboration-archived-issue-${localIssue}`), {
        visible: false,
      })
      await control.command('click', scoped('collaboration-issue-archive-drawer-close'))
      await control.command('click', scoped('milestones-back'))
      await control.command('waitFor', scoped(`milestone-${localId}`), { text: '100%' })
      await control.command('click', scoped('milestone-create'))
      await control.command('fill', scoped('milestone-title'), { value: 'Follow-up release' })
      await control.command('clickWhenEnabled', scoped('milestone-save'))
      await control.command('waitFor', scoped('milestones-page'), { text: 'Follow-up release' })
      const followUp = (
        await requestExecutor(
          control,
          'milestones.list',
          { project_id: localProject.id },
          uiTimeoutMs
        )
      ).find(candidate => candidate.title === 'Follow-up release')
      assert.ok(followUp)
      await control.command('click', scoped(`milestone-open-${followUp.id}`))
      await control.command('click', scoped('collaboration-issue-table-empty-create'))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`)
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        followUp.id
      )
      await control.command('fill', scoped('cloud-todo-title'), {
        value: 'Remaining local delivery',
      })
      await selectMilestone(control, '')
      await control.command('click', scoped('cloud-todo-modal-close'))
      await control.command('click', scoped('collaboration-issue-table-empty-create'))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`)
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        ''
      )
      await selectMilestone(control, followUp.id)
      await waitForValue(
        () => control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        value => value === followUp.id,
        'The selected milestone must appear before capturing the creation draft',
        uiTimeoutMs
      )
      await captureScreenshot(control, 'milestones-08e-context-create.png', 'body')
      await control.command('clickWhenEnabled', scoped('cloud-todo-create-confirm'))
      await control.command('waitFor', scoped('collaboration-issue-detail'), {
        text: 'Remaining local delivery',
      })
      await control.command('click', scoped('cloud-todo-detail-close'))
      await control.command('click', scoped('milestones-back'))
      await bulkMilestone(control, followUp.id)
      await assertCompactActions(control, true)
      await captureScreenshot(control, 'milestones-08c-local-table-bulk.png', 'body')
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${followUp.id}`), { text: '50%' })
      await assertProgress(control, followUp.id, 50)
      await captureScreenshot(control, 'milestones-08d-local-multiple-progress.png', 'body')
      await bulkMilestone(control, null)
      await openMilestones(control)
      await control.command('waitFor', scoped(`milestone-${followUp.id}`), { text: '0%' })
      const cleared = (
        await requestExecutor(
          control,
          'milestones.list',
          { project_id: localProject.id },
          uiTimeoutMs
        )
      ).find(candidate => candidate.id === followUp.id)
      assert.equal(cleared.open_issues + cleared.closed_issues, 0)
      await bulkMilestone(control, localId)
      const child = await requestExecutor(
        control,
        'todos.create',
        {
          project_id: localProject.id,
          todo: {
            title: 'Cross-milestone child',
            parent_id: localIssue,
            milestone_id: followUp.id,
            status: 'completed',
            priority: 'none',
            tags: [],
          },
        },
        uiTimeoutMs
      )
      await reloadMainWindow(control, 'The cross-milestone child must survive reopening')
      await selectCollaborationProjectView(control, CONTENT, 'board', workbenchReadyTimeoutMs)
      await control.command('waitFor', `${scoped('milestone-filter')}:enabled`)
      await selectMilestone(control, localId, 'milestone-filter')
      await control.command('waitFor', scoped(`cloud-todo-card-${localIssue}`))
      await control.command('waitFor', scoped(`cloud-todo-card-milestone-${localIssue}`), {
        text: '协作交付目标',
      })
      await assertToolbarTypography(control)
      await selectMilestone(control, 'all', 'milestone-filter')
      await control.command('click', scoped('cloud-board-parent-layout'))
      await control.command('waitFor', scoped('cloud-board-parent-rows'))
      const parentHeader = `${scoped(`cloud-board-parent-row-${localIssue}`)} > header`
      await control.command(
        'waitFor',
        `${parentHeader} [data-testid="cloud-board-parent-open-${localIssue}"]`
      )
      const parentMilestone = `${parentHeader} [data-testid="cloud-todo-card-milestone-${localIssue}"]`
      await control.command('waitFor', parentMilestone, {
        text: '协作交付目标',
      })
      await control.command('scrollIntoView', parentMilestone)
      await captureScreenshot(control, 'milestones-08g-parent-milestone.png', 'body')
      await control.command('click', scoped('cloud-board-parent-layout'))
      await selectMilestone(control, localId, 'milestone-filter')
      await control.command('waitFor', scoped(`cloud-todo-card-${localIssue}`))
      await control.command('scrollIntoView', scoped(`cloud-todo-card-milestone-${localIssue}`))
      await captureScreenshot(control, 'milestones-08h-board-milestone.png', 'body')
      await control.command('waitFor', scoped(`collaboration-issue-children-${localIssue}`), {
        text: '1/1',
      })
      const childrenAction = scoped(`collaboration-issue-children-${localIssue}`)
      const metadata = scoped(`cloud-todo-card-metadata-${localIssue}`)
      assert.equal(
        await style(control, `${childrenAction} > span`, 'font-size'),
        await style(control, metadata, 'font-size'),
        'Child progress must use the card metadata text size'
      )
      const [ring] = JSON.parse(
        await control.command('getElementMetrics', `${childrenAction} > svg`)
      )
      const [metadataIcon] = JSON.parse(
        await control.command('getElementMetrics', `${metadata} svg`)
      )
      assert.ok(ring.width <= metadataIcon.width, 'Child progress icon must match metadata density')
      assert.equal(
        Number(await control.command('getElementCount', scoped(`cloud-todo-card-${child.id}`))),
        0
      )
      await control.command(
        'clickWhenEnabled',
        scoped(`collaboration-issue-children-${localIssue}`)
      )
      await control.command('waitFor', scoped(`cloud-todo-board-breadcrumb-${localIssue}`))
      assert.equal(
        await control.command('getAttribute', scoped('milestone-filter'), { value: 'data-value' }),
        'all'
      )
      await control.command('waitFor', scoped(`cloud-todo-card-${child.id}`), {
        text: 'Cross-milestone child',
      })
      await control.command('scrollIntoView', scoped(`cloud-todo-card-${child.id}`))
      await assertCompactActions(control)
      await captureScreenshot(control, 'milestones-08f-cross-milestone-children.png', 'body')
      await control.command(
        'clickWhenEnabled',
        `${scoped('cloud-todo-board-breadcrumb')} > div > button`
      )
      await control.command('waitFor', scoped(`cloud-todo-card-${localIssue}`))
      assert.equal(
        await control.command('getAttribute', scoped('milestone-filter'), { value: 'data-value' }),
        localId
      )
      await selectMilestone(control, localId, 'milestone-filter')
      await openMilestones(control)
      await deleteMilestone(control, localId)
      await captureScreenshot(control, 'milestones-09-local-deleted.png', 'body')
      await selectCollaborationProjectView(control, CONTENT, 'board')
      await control.command('waitFor', scoped(`cloud-todo-card-${localIssue}`), {
        text: 'Local milestone Issue',
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', scoped(`cloud-todo-card-${localIssue}`))
      await control.command('waitFor', `${scoped('issue-milestone')}:enabled`, {
        timeoutMs: uiTimeoutMs,
      })
      assert.equal(
        await control.command('getAttribute', scoped('issue-milestone'), { value: 'data-value' }),
        ''
      )
      await control.command('click', scoped('cloud-todo-detail-close'))
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-mode-dark"]')
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/local/${localProject.id}`,
      })
      await openMilestones(control)
      await control.command('click', scoped('milestone-create'))
      await control.command('fill', scoped('milestone-title'), {
        value: '夜间发布里程碑 / Dark mode release',
      })
      await captureScreenshot(control, 'milestones-10-local-dark-form.png', 'body')
      await control.command('click', scoped('milestone-cancel'))
    },
    async cleanup() {
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
