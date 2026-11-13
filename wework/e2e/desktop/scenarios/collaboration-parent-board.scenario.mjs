import { showAllCollaborationIssues } from '../modules/collaboration-board-flows.mjs'
import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { dragBoardCard, waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { verifyGanttHierarchyAndDetailArchive } from '../modules/collaboration-gantt-hierarchy.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const test = id => scoped(`[data-testid="${id}"]`)

export function createDesktopScenario({ captureScreenshot, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  let project
  const fixture = {}
  return {
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const click = id => control.command('clickWhenEnabled', test(id), { timeoutMs: uiTimeoutMs })
      const wait = (id, text) =>
        control.command('waitFor', test(id), { text, timeoutMs: uiTimeoutMs })
      const capture = name => captureScreenshot(control, `parent-board-${name}.png`, 'body')
      const get = async id => {
        const record = await rpc('todos.get', { project_id: project.id, task_id: id })
        return { ...record, tags: record.metadata.tags }
      }
      const create = (title, parent_id, tags, status = 'pending') =>
        rpc('todos.create', {
          project_id: project.id,
          todo: { title, parent_id, tags, status },
        })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1728, height: 1080 }),
      })
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const name = `父子协作验收-${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      project = (await rpc('projects.list', {})).find(p => p.name === name)
      assert.ok(project)
      fixture.parent = await create('账号登录体验升级', null, [])
      fixture.other = await create('协作通知体验优化', null, [])
      fixture.standalone = await create('独立事项：排查启动日志', null, ['develop'])
      fixture.long = await create(
        '跨端会话恢复与异常网络提示 — Verify session recovery across desktop and cloud workspaces',
        null,
        ['develop']
      )
      fixture.design = await create(
        '产品设计与异常反馈',
        fixture.parent.id,
        ['design'],
        'completed'
      )
      fixture.front = await create(
        '前端登录与会话恢复',
        fixture.parent.id,
        ['develop', 'frontend'],
        'in_progress'
      )
      fixture.back = await create(
        '认证接口与会话管理',
        fixture.parent.id,
        ['develop'],
        'in_progress'
      )
      fixture.tests = await create('登录链路测试用例', fixture.parent.id, ['test'], 'in_progress')
      fixture.release = await create('登录功能验收', fixture.parent.id, ['release'])
      fixture.otherChild = await create('通知分类与阅读规则', fixture.other.id, ['design'])
      fixture.grandchild = await create('验证码交互边界', fixture.front.id, ['design'])
      await rpc('projects.update', {
        project_id: project.id,
        project: {
          version: project.version,
          board_views: {
            schema_version: 1,
            default_view_id: 'development',
            views: [
              {
                id: 'development',
                name: '整体进展',
                columns: [
                  { id: 'backlog', type: 'unmatched', value: 'Backlog' },
                  ...['design', 'develop', 'test', 'release'].map(value => ({
                    id: value,
                    type: 'tag',
                    value,
                  })),
                ],
              },
            ],
          },
        },
      })
      await reloadMainWindow(control, 'Parent board fixtures did not reload')
      await showAllCollaborationIssues(control, CONTENT)
      await wait(`cloud-todo-card-${fixture.parent.id}`, fixture.parent.title)
      assert.equal(
        Number(
          await control.command('getElementCount', test(`cloud-todo-card-${fixture.front.id}`))
        ),
        0,
        'The ordinary board must retain its current-level projection'
      )
      await capture('01-existing-board')
      await click('cloud-board-parent-layout')
      await wait('cloud-board-parent-rows', fixture.front.title)
      await wait(`cloud-board-parent-row-${fixture.parent.id}`, '1/5 已完成')
      await wait(`cloud-board-parent-parallel-${fixture.parent.id}`, '3 项并行中')
      assert.equal(
        Number(
          await control.command('getElementCount', test(`cloud-todo-card-${fixture.grandchild.id}`))
        ),
        0
      )
      await capture('02-parallel-children')
      await click(`cloud-board-parent-toggle-parent:${fixture.parent.id}`)
      await control.command('waitFor', test(`cloud-todo-card-${fixture.front.id}`), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await capture('02b-collapsed-parent')
      await click(`cloud-board-parent-toggle-parent:${fixture.parent.id}`)
      await wait(`cloud-todo-card-${fixture.front.id}`, fixture.front.title)
      await control.command('fill', test('cloud-board-search'), { value: fixture.parent.title })
      await wait(`cloud-todo-card-${fixture.front.id}`, fixture.front.title)
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            test(`cloud-board-parent-row-${fixture.other.id}`)
          )
        ),
        0
      )
      await capture('02c-single-parent-search')
      await control.command('fill', test('cloud-board-search'), { value: 'no matching issue' })
      await wait('cloud-board-parent-rows', '暂无匹配的事项')
      await capture('02d-empty-search')
      await control.command('fill', test('cloud-board-search'), { value: '跨端' })
      await wait(`cloud-todo-card-${fixture.long.id}`, '跨端会话恢复')
      await capture('02e-long-title-standalone')
      await control.command('fill', test('cloud-board-search'), { value: '' })
      await wait(`cloud-todo-card-${fixture.front.id}`, fixture.front.title)

      await click(`cloud-todo-card-${fixture.front.id}`)
      await wait('issue-parent-link', fixture.parent.title)
      await capture('03-child-detail')
      await click('issue-parent-link')
      await wait('issue-children-progress', '1/5 已完成')
      await wait(`issue-hierarchy-child-${fixture.front.id}`, fixture.front.title)
      await capture('04-parent-detail')
      await click(`issue-hierarchy-child-${fixture.front.id}`)
      await wait('issue-parent-link', fixture.parent.title)
      await click('cloud-todo-detail-close')

      const cell = (parent, column) => test(`cloud-board-parent-cell-${parent}-${column}`)
      await dragBoardCard(
        control,
        `${cell(fixture.parent.id, 'develop')} [data-testid="cloud-todo-card-${fixture.front.id}"]`,
        cell(fixture.parent.id, 'test'),
        uiTimeoutMs
      )
      await waitForBoardValue(
        async () => (await get(fixture.front.id)).tags,
        ['frontend', 'test'],
        'Tag move must persist without losing business tags',
        uiTimeoutMs
      )
      const moved = await get(fixture.front.id)
      assert.equal(moved.status, 'in_progress')
      assert.equal(moved.parent_id, fixture.parent.id)
      await capture('05-tag-move-state-independent')
      await dragBoardCard(
        control,
        `${cell(fixture.parent.id, 'test')} [data-testid="cloud-todo-card-${fixture.front.id}"]`,
        cell(fixture.other.id, 'release'),
        uiTimeoutMs
      )
      // Observe the negative contract across an async persistence window.
      const until = Date.now() + 1500
      while (Date.now() < until) {
        const unchanged = await get(fixture.front.id)
        assert.deepEqual(
          {
            version: unchanged.version,
            parent: unchanged.parent_id,
            tags: unchanged.tags,
            status: unchanged.status,
          },
          {
            version: moved.version,
            parent: moved.parent_id,
            tags: moved.tags,
            status: moved.status,
          },
          'Cross-parent empty-cell drop must not mutate storage'
        )
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      await capture('06-cross-parent-drop-rejected')

      await click(`cloud-todo-card-${fixture.front.id}`)
      await control.command('select', test('cloud-todo-detail-status'), { value: 'completed' })
      await capture('06b-completion-selected')
      await waitForBoardValue(
        async () => (await get(fixture.front.id)).status,
        'completed',
        'Completion must persist',
        uiTimeoutMs
      )
      assert.equal((await get(fixture.back.id)).status, 'in_progress')
      await click('issue-parent-link')
      await wait('issue-children-progress', '2/5 已完成')
      await capture('07-completion-rollup')
      await click('cloud-todo-detail-close')

      await click(`cloud-board-parent-enter-${fixture.parent.id}`)
      await wait(`cloud-board-parent-open-${fixture.front.id}`, fixture.front.title)
      await wait(`cloud-todo-card-${fixture.grandchild.id}`, fixture.grandchild.title)
      await capture('08-nested-hierarchy')
      await click(`cloud-todo-board-breadcrumb-${fixture.parent.id}`)
      await click(`cloud-board-parent-open-${fixture.front.id}`)
      await click('issue-hierarchy-add-child')
      await wait('cloud-todo-create-panel', '')
      await control.command('fill', test('cloud-todo-title'), { value: '新增子事项：会话过期反馈' })
      await click('cloud-todo-create-confirm')
      await wait('collaboration-issue-detail', '新增子事项：会话过期反馈')
      await wait('issue-parent-link', fixture.front.title)
      const storedChildren = await rpc('todos.list', { project_id: project.id })
      const created = storedChildren.find(issue => issue.title === '新增子事项：会话过期反馈')
      assert.ok(created, 'The UI-created child must exist in real local persistence')
      assert.equal(created.parent_id, fixture.front.id)
      await capture('09-created-child-linked')
      await click('cloud-todo-detail-close')
      for (let index = 1; index <= 8; index += 1) {
        await create(`会话恢复边界用例 ${index}`, fixture.front.id, ['test'])
      }

      await reloadMainWindow(control, 'Parent board preference did not reload')
      await wait('cloud-board-parent-rows', fixture.front.title)
      assert.equal(
        await control.command('getAttribute', test('cloud-board-parent-layout'), {
          value: 'aria-pressed',
        }),
        'true'
      )
      await capture('10-reload-persisted')
      await click(`cloud-todo-card-${fixture.front.id}`)
      await wait('issue-children-progress', '0/10 已完成')
      const [childrenList] = JSON.parse(
        await control.command('getElementMetrics', test('issue-hierarchy-children-list'))
      )
      assert.ok(
        childrenList.clientHeight > 0 && childrenList.scrollHeight > childrenList.clientHeight,
        'A long sub-issue list must scroll internally instead of displacing the remaining detail'
      )
      await capture('10b-long-children-list')
      await control.command(
        'scrollIntoView',
        test(`issue-hierarchy-child-${fixture.grandchild.id}`)
      )
      await control.command('waitFor', test(`issue-hierarchy-child-${fixture.grandchild.id}`), {
        visible: true,
        timeoutMs: uiTimeoutMs,
      })
      const [scrolledList] = JSON.parse(
        await control.command('getElementMetrics', test('issue-hierarchy-children-list'))
      )
      const [lastChild] = JSON.parse(
        await control.command(
          'getElementMetrics',
          test(`issue-hierarchy-child-${fixture.grandchild.id}`)
        )
      )
      assert.ok(scrolledList.scrollTop > 0, 'The sub-issue list must actually scroll')
      assert.ok(
        lastChild.top >= scrolledList.top - 1 && lastChild.bottom <= scrolledList.bottom + 1,
        'The initially offscreen sub-issue must enter the list viewport'
      )
      await capture('10c-long-children-scrolled')
      await click('cloud-todo-detail-close')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1024, height: 800 }),
      })
      await wait('cloud-board-parent-rows', fixture.front.title)
      await capture('11-narrow-window')
      await control.command('setMainWindowSize', 'body', {
        value: JSON.stringify({ width: 1728, height: 1080 }),
      })
      await control.command('navigate', 'body', { value: '/settings/appearance' })
      await control.command('waitFor', '[data-testid="appearance-mode-dark"]', {
        timeoutMs: uiTimeoutMs,
      })
      await control.command('click', '[data-testid="appearance-mode-dark"]')
      await control.command('waitFor', 'html[data-theme="dark"]', { timeoutMs: uiTimeoutMs })
      await control.command('openWeworkScheme', 'body', {
        value: `wework://boards/local/${project.id}`,
      })
      await wait('cloud-board-parent-rows', fixture.front.title)
      await capture('12-dark-theme')
      await click('cloud-board-parent-layout')
      await control.command('waitFor', test('cloud-board-parent-rows'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await capture('13-return-to-ordinary-board')
      await verifyGanttHierarchyAndDetailArchive(control, project, uiTimeoutMs)
      await capture('14-gantt-hierarchy-restored')
    },
    diagnostics() {
      return {
        projectId: project?.id,
        issueIds: Object.fromEntries(
          Object.entries(fixture).map(([key, value]) => [key, value.id])
        ),
      }
    },
  }
}
