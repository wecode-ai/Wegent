import assert from 'node:assert/strict'

import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { createTaskDeliveryIssueRegression } from '../modules/task-delivery-issue.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const PROJECT = `交付快照验收-${process.pid}`
const TITLE = '验证多批交付与会话快照'
const scoped = selector => `${CONTENT} ${selector}`
const row = id => scoped(`[data-testid="todo-detail-open-delivery-${id}"]`)
const panel = scoped('[data-testid="todo-detail-delivery-panel"]')

async function metrics(control, selector) {
  const result = JSON.parse(await control.command('getElementMetrics', selector))
  assert.equal(result.length, 1, `Expected exactly one ${selector}`)
  return result[0]
}

export function createDesktopScenario(options) {
  const { uiTimeoutMs, workbenchReadyTimeoutMs, captureScreenshot } = options
  const taskDelivery = createTaskDeliveryIssueRegression(options)
  let project
  let issue
  const batches = []
  return {
    handleHttp: taskDelivery.handleHttp,
    async verify(control) {
      console.log('[delivery-e2e] Starting real delivery snapshot assertions')
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      await createLocalCollaborationProject(control, CONTENT, PROJECT)
      project = (await rpc('projects.list', {})).find(candidate => candidate.name === PROJECT)
      assert.ok(project, 'The real local project must exist')
      issue = await rpc('todos.create', { project_id: project.id, todo: { title: TITLE } })

      const createBatch = async (markdown, chat, files) => {
        const draft = await rpc('deliveries.create', {
          project_id: project.id,
          item_id: issue.id,
          delivery: { markdown, chat },
        })
        for (const name of files) {
          await rpc('deliveries.add_asset', {
            delivery_id: draft.id,
            relative_path: `reports/${name}`,
            file: {
              display_name: name,
              content_type: 'text/plain',
              base64: Buffer.from(name).toString('base64'),
            },
          })
        }
        const result = await rpc('deliveries.finalize', {
          item_id: issue.id,
          delivery_id: draft.id,
        })
        assert.equal(result.status, 'delivered')
        batches.push(result)
        return result
      }
      const mixed = await createBatch(
        '# 分析结论\n\n交付说明正文',
        {
          scope: 'selected',
          messages: [
            { role: 'user', content: '请给出分析结论' },
            {
              role: 'assistant',
              content: '**会话结论**：已完成分析。\n\n3. 保留编号\n4. 核对附件',
            },
          ],
        },
        ['analysis.txt', 'evidence.txt']
      )
      const chatOnly = await createBatch(
        '',
        {
          selection: { mode: 'all' },
          messages: [
            { sender: { type: 'user', name: 'Local user' }, content: '项目讨论问题' },
            { sender: { type: 'agent', name: 'Analyst' }, content: '项目讨论答复' },
          ],
        },
        []
      )
      const filesOnly = await createBatch('', null, ['result.txt'])
      assert.equal((await rpc('deliveries.list', { item_id: issue.id })).length, 3)

      await reloadMainWindow(control)
      const card = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
      await control.command('waitFor', card, { text: TITLE })
      await control.command('click', card)
      await control.command('waitFor', row(filesOnly.id), { text: '1 个附件' })
      await control.command('waitFor', row(chatOnly.id), { text: '2 条消息' })
      assert.match(await control.command('getText', row(filesOnly.id)), /result\.txt/)
      // The E2E cloud identity differs from the device-owned local author (0).
      assert.match(await control.command('getText', row(chatOnly.id)), /用户 #0 交付/)
      assert.equal(Number(await control.command('getElementCount', row(mixed.id))), 0)
      await control.command('click', scoped('[data-testid="todo-detail-toggle-deliveries"]'))
      await control.command('waitFor', row(mixed.id), { text: '交付说明 · 2 条消息 · 2 个附件' })
      const mixedText = await control.command('getText', row(mixed.id))
      assert.match(mixedText, /分析结论/)
      assert.match(mixedText, /analysis\.txt.*evidence\.txt/s)
      assert.match(mixedText, /\d{2}-\d{2} \d{2}:\d{2}/)
      await captureScreenshot(control, 'delivery-01-batches.png', CONTENT)

      const drawer = await metrics(control, scoped('.issue-drawer-detail'))
      await control.command('click', row(mixed.id))
      await control.command('waitFor', panel, { text: '会话结论' })
      const delivered = await metrics(control, panel)
      assert.ok(
        Math.abs(delivered.width - drawer.width) <= 2,
        'Delivery must fill the Issue drawer'
      )
      assert.ok(
        Math.abs(delivered.left - drawer.left) <= 2,
        'Delivery must keep the Issue drawer origin'
      )
      assert.ok(delivered.height > 300, 'Delivery must retain the full drawer height')
      assert.equal(await control.command('getText', `${panel} strong`), '会话结论')
      assert.equal(await control.command('getAttribute', `${panel} ol`, { value: 'start' }), '3')
      assert.match(await control.command('getText', panel), /交付说明正文/)
      assert.match(await control.command('getText', panel), /reports\/analysis\.txt/)
      await captureScreenshot(control, 'delivery-02-mixed-snapshot.png', CONTENT)
      await control.command('click', scoped('[data-testid="todo-detail-delivery-back"]'))
      await control.command('waitFor', row(chatOnly.id), { text: '2 条消息' })
      await control.command('click', row(chatOnly.id))
      await control.command('waitFor', panel, { text: '项目讨论答复' })
      const chat = await control.command('getText', panel)
      assert.ok(chat.indexOf('项目讨论问题') < chat.indexOf('项目讨论答复'))
      assert.doesNotMatch(chat, /无交付说明|附件/)
      await captureScreenshot(control, 'delivery-03-chat-only.png', CONTENT)
      await control.command('click', scoped('[data-testid="todo-detail-delivery-back"]'))
      await control.command('click', row(filesOnly.id))
      await control.command('waitFor', panel, { text: 'reports/result.txt' })
      assert.doesNotMatch(await control.command('getText', panel), /无交付说明|交付会话/)
      await control.command('click', scoped('[data-testid="todo-detail-delivery-close"]'))
      await control.command('waitFor', panel, { visible: false })
      await control.command('click', card)
      await control.command('waitFor', row(chatOnly.id), { text: '2 条消息' })
      await control.command('click', row(chatOnly.id))
      await control.command('waitFor', panel, { text: '项目讨论答复' })
      await control.command('click', scoped('[data-testid="todo-detail-delivery-close"]'))
      console.log(`[delivery-e2e] Verified three persisted batches for ${issue.id}`)
      await taskDelivery.verify(control, { project, issue })
    },
    diagnostics() {
      return {
        projectId: project?.id,
        issueId: issue?.id,
        deliveryIds: batches.map(batch => batch.id),
      }
    },
  }
}
