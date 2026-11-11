import assert from 'node:assert/strict'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
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
      let groupId
      const owners = new Map()
      const openBoard = async () => {
        await control.command('openWeworkScheme', 'body', {
          value: `wework://boards/local/${project.id}`,
        })
        await control.command('waitFor', scoped('collaboration-board'), { timeoutMs: uiTimeoutMs })
      }
      const openSettings = async () => {
        await control.command('waitFor', scoped('thread-room'), { timeoutMs: uiTimeoutMs })
        await control.command('click', scoped('thread-settings'))
        await control.command('waitFor', scoped('thread-settings-panel'), {
          timeoutMs: uiTimeoutMs,
        })
      }
      const readIssue = id => {
        assert.ok(owners.has(id), 'The created Thread must retain its actual group owner')
        return requestExecutor(
          control,
          'todos.get',
          { project_id: owners.get(id), task_id: id },
          uiTimeoutMs
        )
      }
      const createIssue = async (title, status) => {
        await control.command('clickWhenEnabled', scoped('collaboration-issue-create'))
        await control.command('chooseWhenEnabled', portal('thread-create-group-select'), {
          value: groupId ?? '__new__',
          timeoutMs: uiTimeoutMs,
        })
        if (!groupId)
          await control.command('fill', portal('thread-create-new-group-name'), {
            value: name + ' group',
          })
        await control.command('clickWhenEnabled', portal('thread-create-group-next'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('cloud-todo-title'), { timeoutMs: uiTimeoutMs })
        await control.command('fill', scoped('cloud-todo-title'), { value: title })
        await control.command('select', scoped('cloud-todo-create-status'), { value: status })
        await control.command('clickWhenEnabled', scoped('cloud-todo-create-confirm'), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('waitFor', scoped('thread-room'), {
          text: title,
          timeoutMs: uiTimeoutMs,
        })
        const created = await waitForValue(
          () => requestExecutor(control, 'todos.list', { project_id: project.id }, uiTimeoutMs),
          issues => issues.some(issue => issue.title === title),
          'UI-created Thread must appear in its optional project',
          uiTimeoutMs
        )
        const issue = created.find(issue => issue.title === title)
        assert.ok(issue.group_id, 'Creation must produce a group-owned Thread')
        assert.equal(issue.cloud_project_id, issue.group_id)
        groupId = issue.group_id
        owners.set(issue.id, groupId)
        await openBoard()
        return issue.id
      }
      const first = await createIssue('First tagged Issue', 'pending')
      const second = await createIssue('Second tagged Issue', 'pending')
      const untagged = await createIssue('Untagged Issue', 'pending')
      const editTag = async (id, tag) => {
        await control.command('click', scoped(`cloud-todo-card-${id}`))
        await openSettings()
        await control.command('fill', scoped('thread-settings-tags-input'), { value: tag })
        await control.command('press', scoped('thread-settings-tags-input'), { key: 'Enter' })
        await waitForValue(
          () => readIssue(id),
          issue => issue.metadata.tags.includes(tag),
          'Tag must persist without pressing Save',
          uiTimeoutMs
        )
        await control.command('press', scoped('thread-settings-tags-input'), { key: 'Escape' })
        await control.command('clickWhenEnabled', scoped('thread-settings-close'))
        await openBoard()
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
      await openSettings()
      await control.command('fill', scoped('thread-settings-title'), {
        value: 'Immediately renamed Issue',
      })
      await control.command('press', scoped('thread-settings-title'), { key: 'Enter' })
      await control.command('click', scoped('thread-settings-milestone'))
      await control.command('fill', portal('thread-settings-milestone-search'), {
        value: 'searchable',
      })
      await control.command('click', portal(`thread-settings-milestone-option-${milestone.id}`))
      await waitForValue(
        () => readIssue(first),
        issue =>
          issue.title === 'Immediately renamed Issue' &&
          issue.metadata.milestone_id === milestone.id,
        'Title and milestone must persist independently',
        uiTimeoutMs
      )
      await control.command('click', scoped('thread-settings-description'))
      await control.command('fill', scoped('thread-settings-description'), {
        value: 'Description requires an explicit save',
      })
      await control.command('select', scoped('thread-settings-priority'), { value: 'urgent' })
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
      await control.command('clickWhenEnabled', scoped('thread-settings-save'))
      await waitForValue(
        () => readIssue(first),
        issue => issue.description.includes('Description requires an explicit save'),
        'Explicit description save must persist',
        uiTimeoutMs
      )
      await captureScreenshot(control, 'issue-property-autosave.png', CONTENT)
      await control.command('clickWhenEnabled', scoped('thread-settings-close'))
      await openBoard()
      await reloadMainWindow(control, 'Persisted Issue properties must survive reloading')
      await control.command('waitFor', scoped(`cloud-todo-card-${first}`), {
        text: 'Immediately renamed Issue',
      })
      await control.command('click', scoped(`cloud-todo-card-${first}`))
      await openSettings()
      await control.command('waitFor', scoped('thread-settings-title'))
      await waitForValue(
        () => control.command('getValue', scoped('thread-settings-title')),
        title => title === 'Immediately renamed Issue',
        'Renamed title must survive reloading',
        uiTimeoutMs
      )
      await control.command('waitFor', scoped('thread-settings-milestone'), {
        text: 'Searchable release',
      })
      assert.equal((await readIssue(first)).priority, 'urgent')
      await control.command('clickWhenEnabled', scoped('thread-settings-close'))
      await openBoard()
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
