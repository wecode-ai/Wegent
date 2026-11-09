import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { waitForBoardValue } from '../modules/collaboration-board-flows.mjs'
import { createDesktopScenario as createParentBoardScenario } from './collaboration-parent-board.scenario.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const test = id => `${CONTENT} [data-testid="${id}"]`

// Reuse the existing checkpoint lifecycle and retain all parent-board assertions.
export function createDesktopScenario(options) {
  const parentBoard = createParentBoardScenario(options)
  const { uiTimeoutMs, workbenchReadyTimeoutMs } = options
  let project
  let parent
  return {
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const wait = (selector, text) =>
        control.command('waitFor', selector, { text, timeoutMs: uiTimeoutMs })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const name = `子任务进度验收-${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      project = (await rpc('projects.list', {})).find(candidate => candidate.name === name)
      assert.ok(project)
      const create = (title, parentId = null) =>
        rpc('todos.create', {
          project_id: project.id,
          todo: { title, parent_id: parentId, status: 'pending' },
        })
      parent = await create('父任务进度')
      const standalone = await create('没有子任务')
      const children = []
      for (let index = 0; index < 5; index += 1) {
        children.push(await create(`子任务-${index}`, parent.id))
      }
      await create('孙任务不累计', children[0].id)
      await reloadMainWindow(control, 'Sub-issue progress fixtures did not reload')
      const progress = test(`collaboration-issue-children-${parent.id}`)
      await wait(progress, '子任务 0/5')
      assert.equal(
        Number(
          await control.command(
            'getElementCount',
            test(`collaboration-issue-children-${standalone.id}`)
          )
        ),
        0
      )
      const complete = async child => {
        await control.command('clickWhenEnabled', test(`cloud-todo-card-${child.id}`), {
          timeoutMs: uiTimeoutMs,
        })
        await control.command('select', test('cloud-todo-detail-status'), { value: 'completed' })
        await waitForBoardValue(
          async () =>
            (await rpc('todos.get', { project_id: project.id, task_id: child.id })).status,
          'completed',
          'Completing a sub-issue through the UI must persist',
          uiTimeoutMs
        )
        await control.command('clickWhenEnabled', test('cloud-todo-detail-close'), {
          timeoutMs: uiTimeoutMs,
        })
      }
      await control.command('clickWhenEnabled', progress, { timeoutMs: uiTimeoutMs })
      await wait(test(`cloud-todo-card-${children[0].id}`), children[0].title)
      for (const child of children.slice(0, 2)) await complete(child)
      await control.command('click', `${test('cloud-todo-board-breadcrumb')} > div > button`)
      await wait(progress, '子任务 2/5')
      await options.captureScreenshot(control, 'card-child-progress-2-of-5.png', 'body')
      assert.equal(
        await control.command('getAttribute', `${progress} circle[pathLength]`, {
          value: 'stroke-dasharray',
        }),
        '0.4 1'
      )
      assert.equal(
        await control.command('getAttribute', progress, { value: 'aria-label' }),
        '已完成 2/5 个子任务，点击进入子任务看板'
      )
      await control.command('fill', test('cloud-board-search'), { value: parent.title })
      await wait(progress, '子任务 2/5')
      await control.command('fill', test('cloud-board-search'), { value: '' })
      await control.command('clickWhenEnabled', progress, { timeoutMs: uiTimeoutMs })
      await wait(test(`cloud-todo-card-${children[0].id}`), children[0].title)
      await control.command('waitFor', test('collaboration-issue-detail'), {
        visible: false,
        timeoutMs: uiTimeoutMs,
      })
      await wait(test(`collaboration-issue-children-${children[0].id}`), '子任务 0/1')
      for (const child of children.slice(2)) await complete(child)
      await control.command('click', `${test('cloud-todo-board-breadcrumb')} > div > button`)
      await wait(progress, '子任务 5/5')
      assert.equal(
        await control.command('getAttribute', `${progress} circle[pathLength]`, {
          value: 'stroke-dasharray',
        }),
        '1 1'
      )
      assert.ok(
        (await control.command('getAttribute', `${progress} svg`, { value: 'class' })).includes(
          'text-emerald-600'
        )
      )
      await parentBoard.verify(control)
    },
    diagnostics() {
      return {
        progressProjectId: project?.id,
        progressParentId: parent?.id,
        parentBoard: parentBoard.diagnostics(),
      }
    },
  }
}
