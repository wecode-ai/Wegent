import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { createCollaborationBoardIssue } from '../modules/collaboration-board-issue.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { waitForValue } from '../modules/workspace-agent-setup.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = id => `${CONTENT} [data-testid="${id}"]`
const portal = id => `[data-testid="${id}"]`

/** User stories: immediate properties, explicit description save, searchable milestones and any-tag filtering. */
export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  return {
    async verify(control) {
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await control.command('waitFor', scoped('collaboration-platform-root'), {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      const name = `Issue property autosave ${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      const projects = await requestExecutor(control, 'projects.list', {}, uiTimeoutMs)
      const project = projects.find(candidate => candidate.name === name)
      assert.ok(project, 'The real local project must exist')
      const milestone = await requestExecutor(
        control,
        'milestones.create',
        {
          project_id: project.id,
          milestone: { title: 'Searchable release', state: 'open' },
        },
        uiTimeoutMs
      )
      const readIssue = id =>
        requestExecutor(control, 'todos.get', { project_id: project.id, task_id: id }, uiTimeoutMs)
      const first = await createCollaborationBoardIssue(
        control,
        'First tagged Issue',
        'pending',
        uiTimeoutMs
      )
      const second = await createCollaborationBoardIssue(
        control,
        'Second tagged Issue',
        'pending',
        uiTimeoutMs
      )
      const untagged = await createCollaborationBoardIssue(
        control,
        'Untagged Issue',
        'pending',
        uiTimeoutMs
      )
      const editTag = async (id, tag) => {
        await control.command('click', scoped(`cloud-todo-card-${id}`))
        await control.command('click', scoped('cloud-todo-more-properties'))
        await control.command('fill', portal('cloud-todo-detail-tag-input'), { value: tag })
        await control.command('press', portal('cloud-todo-detail-tag-input'), { key: 'Enter' })
        await waitForValue(
          () => readIssue(id),
          issue => issue.metadata.tags.includes(tag),
          'Tag must persist without pressing Save',
          uiTimeoutMs
        )
        await control.command('press', portal('cloud-todo-detail-tag-input'), { key: 'Escape' })
        await control.command('click', scoped('cloud-todo-detail-close'))
      }
      await editTag(first, 'bug')
      await editTag(second, 'feature')
      await control.command('click', scoped('cloud-board-tag-filter'))
      await control.command('fill', portal('cloud-board-tag-filter-search'), { value: 'BUG' })
      await control.command('waitFor', portal('cloud-board-tag-filter-option-bug'))
      assert.equal(
        Number(
          await control.command('getElementCount', portal('cloud-board-tag-filter-option-feature'))
        ),
        0
      )
      await control.command('click', portal('cloud-board-tag-filter-option-bug'))
      await control.command('waitFor', scoped(`cloud-todo-card-${second}`), { visible: false })
      await control.command('fill', portal('cloud-board-tag-filter-search'), { value: '' })
      await control.command('click', portal('cloud-board-tag-filter-option-feature'))
      await control.command('waitFor', scoped(`cloud-todo-card-${first}`))
      await control.command('waitFor', scoped(`cloud-todo-card-${second}`))
      await control.command('waitFor', scoped(`cloud-todo-card-${untagged}`), { visible: false })
      await control.command('press', portal('cloud-board-tag-filter-search'), { key: 'Escape' })
      await control.command('click', scoped('cloud-board-tag-filter-clear'))
      await control.command('waitFor', scoped(`cloud-todo-card-${untagged}`))
      await control.command('click', scoped(`cloud-todo-card-${first}`))
      await control.command('fill', scoped('cloud-todo-detail-title'), {
        value: 'Immediately renamed Issue',
      })
      await control.command('press', scoped('cloud-todo-detail-title'), { key: 'Enter' })
      await control.command('click', scoped('issue-milestone'))
      await control.command('fill', portal('issue-milestone-search'), { value: 'searchable' })
      await control.command('click', portal(`issue-milestone-option-${milestone.id}`))
      await waitForValue(
        () => readIssue(first),
        issue =>
          issue.title === 'Immediately renamed Issue' &&
          issue.metadata.milestone_id === milestone.id,
        'Title and milestone must persist independently',
        uiTimeoutMs
      )
      await control.command('click', scoped('cloud-todo-detail-description'))
      await control.command('fill', scoped('cloud-todo-detail-description'), {
        value: 'Description requires an explicit save',
      })
      await control.command('click', scoped('cloud-todo-more-properties'))
      await control.command('select', portal('cloud-todo-detail-priority'), { value: 'urgent' })
      await waitForValue(
        () => readIssue(first),
        issue => issue.priority === 'urgent',
        'Priority must persist without saving the description',
        uiTimeoutMs
      )
      assert.equal(
        (await readIssue(first)).description,
        '',
        'Autosaving properties must not submit the description draft'
      )
      await control.command('click', scoped('cloud-todo-more-properties'))
      await control.command('clickWhenEnabled', scoped('cloud-todo-save'))
      await waitForValue(
        () => readIssue(first),
        issue => issue.description.includes('Description requires an explicit save'),
        'Explicit description save must persist',
        uiTimeoutMs
      )
      await captureScreenshot(control, 'issue-property-autosave.png', CONTENT)
      await reloadMainWindow(control, 'Persisted Issue properties must survive reloading')
      await control.command('waitFor', scoped(`cloud-todo-card-${first}`), {
        text: 'Immediately renamed Issue',
      })
      await control.command('click', scoped(`cloud-todo-card-${first}`))
      await control.command('waitFor', scoped('cloud-todo-detail-title'))
      await waitForValue(
        () => control.command('getValue', scoped('cloud-todo-detail-title')),
        title => title === 'Immediately renamed Issue',
        'Renamed title must survive reloading',
        uiTimeoutMs
      )
      await control.command('waitFor', scoped('issue-milestone'), { text: 'Searchable release' })
      assert.equal((await readIssue(first)).priority, 'urgent')
      await control.command('click', scoped('cloud-todo-detail-close'))
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('clickWhenEnabled', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]')
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/local/${project.id}`,
      })
      await control.command('clickWhenEnabled', scoped('cloud-board-tag-filter'))
      await control.command('waitFor', portal('cloud-board-tag-filter-search'))
      await captureScreenshot(control, 'issue-tag-filter-dark.png', 'body')
      await control.command('press', portal('cloud-board-tag-filter-search'), { key: 'Escape' })
    },
  }
}
