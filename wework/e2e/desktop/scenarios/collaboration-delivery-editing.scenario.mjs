import assert from 'node:assert/strict'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { ensureExperimentalFeaturesEnabled } from '../modules/preferences-automation-flows.mjs'
import { createLocalCollaborationProject, reloadMainWindow } from '../modules/workspace-flows.mjs'
import { startRealObjectStorage } from '../modules/real-object-storage.mjs'
import { createCloudDeliveryEditingRegression } from '../modules/delivery-cloud-editing.mjs'

const CONTENT = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${CONTENT} ${selector}`
const panel = scoped('[data-testid="todo-detail-delivery-panel"]')

export async function createDesktopScenario({ resultDir, uiTimeoutMs, workbenchReadyTimeoutMs }) {
  const storage = await startRealObjectStorage(resultDir, workbenchReadyTimeoutMs)
  const cloud = createCloudDeliveryEditingRegression({ uiTimeoutMs })
  let project
  let issue
  let delivery
  return {
    requiresCloudEnvironment: true,
    backendEnv: storage.backendEnv,
    cleanup: storage.stop,
    prepareCloud: cloud.prepare,
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      const click = testId =>
        control.command('clickWhenEnabled', scoped(`[data-testid="${testId}"]`), { visible: true })
      const fill = (testId, value) =>
        control.command('fill', scoped(`[data-testid="${testId}"]`), { value })
      await ensureExperimentalFeaturesEnabled(control)
      await control.command('waitFor', '[data-testid="workspace-tab-select-fixed-board"]', {
        timeoutMs: workbenchReadyTimeoutMs,
      })
      await control.command('click', '[data-testid="workspace-tab-select-fixed-board"]')
      const name = `交付编辑验收-${process.pid}`
      await createLocalCollaborationProject(control, CONTENT, name)
      project = (await rpc('projects.list', {})).find(candidate => candidate.name === name)
      assert.ok(project)
      issue = await rpc('todos.create', {
        project_id: project.id,
        todo: { title: '持续编辑交付物' },
      })
      const draft = await rpc('deliveries.create', {
        project_id: project.id,
        item_id: issue.id,
        delivery: {
          title: '原交付标题',
          markdown: '原交付备注',
          chat: {
            messages: [
              { role: 'user', content: '原问题' },
              { role: 'assistant', content: '保留的结论' },
            ],
          },
        },
      })
      const asset = await rpc('deliveries.add_asset', {
        delivery_id: draft.id,
        relative_path: 'report.txt',
        file: { display_name: 'report.txt', base64: Buffer.from('original').toString('base64') },
      })
      delivery = await rpc('deliveries.finalize', { item_id: issue.id, delivery_id: draft.id })
      const before = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
      await reloadMainWindow(control)
      const card = scoped(`[data-testid="cloud-todo-card-${issue.id}"]`)
      await control.command('waitFor', card, { text: issue.title })
      await control.command('click', card)
      await click(`todo-detail-open-delivery-${delivery.id}`)
      await control.command('waitFor', panel, { text: '原交付标题' })
      await click('delivery-edit')
      await fill('delivery-edit-title', '修订交付标题')
      await fill('delivery-edit-notes', '修订备注与关键结论')
      await click('delivery-edit-message-0')
      await click(`delivery-edit-asset-${asset.id}`)
      await click('delivery-edit-save')
      await control.command('waitFor', scoped('[data-testid="delivery-edit-form"]'), {
        timeoutMs: uiTimeoutMs,
        visible: false,
      })
      await control.command('waitFor', panel, { text: '修订备注与关键结论' })
      assert.doesNotMatch(await control.command('getText', panel), /原问题|report\.txt/)
      let saved = await rpc('deliveries.get', { delivery_id: delivery.id })
      assert.equal(saved.title, '修订交付标题')
      assert.equal(saved.id, delivery.id)
      assert.equal(saved.delivered_at, delivery.delivered_at)
      assert.equal(saved.assets.length, 0)
      assert.equal(saved.chat.messages.length, 1)
      await click('delivery-edit')
      await fill('delivery-edit-notes', '取消的修改')
      await click('delivery-edit-cancel')
      assert.equal(
        (await rpc('deliveries.get', { delivery_id: delivery.id })).markdown,
        saved.markdown
      )

      // A real concurrent IPC write must reject the stale UI save and retain its draft.
      await click('delivery-edit')
      await fill('delivery-edit-notes', '未保存的本地备注')
      const current = await rpc('deliveries.update', {
        delivery_id: delivery.id,
        delivery: {
          title: saved.title,
          version: saved.version,
          markdown: '并发保存的备注',
          chat: saved.chat,
          retained_asset_ids: [],
          files: [
            {
              relative_path: 'report.txt',
              file: {
                display_name: 'report.txt',
                base64: Buffer.from('replacement').toString('base64'),
              },
            },
          ],
        },
      })
      await click('delivery-edit-save')
      await control.command(
        'waitFor',
        scoped('[data-testid="delivery-edit-form"] [role="alert"]'),
        { text: '交付物已被更新' }
      )
      assert.equal(
        await control.command('getValue', scoped('[data-testid="delivery-edit-notes"]')),
        '未保存的本地备注'
      )
      await click('delivery-edit-reload')
      await control.command('waitFor', panel, { text: '并发保存的备注' })
      await control.command('waitFor', panel, { text: 'report.txt' })
      saved = await rpc('deliveries.get', { delivery_id: delivery.id })
      assert.equal(saved.version, current.version)
      const after = await rpc('todos.get', { project_id: project.id, task_id: issue.id })
      assert.equal(after.status, before.status)
      assert.equal(after.current_delivery_id, before.current_delivery_id)
      assert.equal((await rpc('deliveries.list', { item_id: issue.id })).length, 1)
      await reloadMainWindow(control)
      await control.command('waitFor', card, { text: issue.title })
      await control.command('click', card)
      await click(`todo-detail-open-delivery-${delivery.id}`)
      await control.command('waitFor', panel, { text: '并发保存的备注' })
      await click('todo-detail-delivery-close')
      await cloud.verify(control)
      console.log(
        `[delivery-editing-e2e] Verified editing, cancellation, conflict and persistence for ${issue.id}`
      )
    },
    diagnostics() {
      return {
        projectId: project?.id,
        issueId: issue?.id,
        deliveryId: delivery?.id,
        cloud: cloud.diagnostics(),
      }
    },
  }
}
