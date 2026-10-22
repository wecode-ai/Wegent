import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createSingleRootLocalProject, selectE2EModel } from '../modules/shared.mjs'
import { requestExecutor } from '../modules/executor-rpc.mjs'
import { createSse, streamingTextEvents } from '../modules/response-protocol.mjs'
import { waitForCompletedRuntimeTaskThread } from '../modules/runtime-task-evidence.mjs'

const ACTIVE = '[data-workspace-tab-content][aria-hidden="false"]'
const INPUT = `${ACTIVE} [data-testid="chat-message-input"]`
const ANSWER = 'ARCHIVED_WORKTREE_CLEANUP_READY'

export function createDesktopScenario({ workspacePath, uiTimeoutMs, modelResponseTimeoutMs }) {
  return {
    async handleHttp(request, response, url) {
      if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname))
        return false
      for await (const _chunk of request) {
        /* Drain the real model request. */
      }
      const events = streamingTextEvents(`archive-cleanup-${Date.now()}`, ANSWER, 'final_answer')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.end(createSse([...events.start, ...events.finish]))
      return true
    },
    async verify(control) {
      const rpc = (method, params) => requestExecutor(control, method, params, uiTimeoutMs)
      await createSingleRootLocalProject(control, workspacePath, '归档工作树清理验证')
      await control.command('waitFor', INPUT)
      await selectE2EModel(control)
      await control.command('click', '[data-testid="execution-mode-button"]')
      await control.command(
        'clickWhenEnabled',
        '[data-testid="execution-mode-git-worktree-button"]'
      )
      await control.command('fill', INPUT, { value: 'Reply ARCHIVED_WORKTREE_CLEANUP_READY.' })
      await control.command('press', INPUT, { key: 'Enter' })
      await control.command('waitFor', `${ACTIVE} [data-testid="message-assistant"]`, {
        text: ANSWER,
        timeoutMs: modelResponseTimeoutMs,
      })
      const debug = JSON.parse(await control.command('getWorkbenchDebugSnapshot', 'body'))
      const task = debug.workbench.currentRuntimeTask
      const path = task.workspacePath
      assert.notEqual(path, workspacePath)
      await waitForCompletedRuntimeTaskThread(control, task.taskId, uiTimeoutMs)
      assert.equal((await rpc('runtime.tasks.archive', task)).accepted, true)
      const markerPath = join(path, '.git')
      const marker = await readFile(markerPath, 'utf8')
      // Damage only this isolated fixture's Git link to exercise a real cleanup failure.
      await writeFile(markerPath, `gitdir: ${join(path, 'missing-git/worktrees/fixture')}\n`)
      try {
        await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
        const suffix = `${task.deviceId}-${task.taskId}`.replace(/[^a-zA-Z0-9_-]/g, '-')
        const button = `[data-testid="archived-delete-button-${suffix}"]`
        const remove = async () => {
          await control.command('waitFor', button)
          await control.command('click', button)
          await control.command(
            'click',
            '[data-testid="archived-delete-confirm-dialog-confirm-button"]'
          )
        }
        await remove()
        await control.command('waitFor', '[data-testid="archived-operation-error"]', { text: path })
        await control.command('waitFor', button)
        await access(path)
        const listed = await rpc('runtime.worktrees.list', {})
        assert.ok(
          listed.items.some(item => item.path === path),
          'Failed cleanup lost its managed worktree'
        )
        await control.command('navigate', 'body', { value: '/settings/worktrees' })
        await control.command('waitFor', '[data-testid="worktree-error"]', { text: path })
        await control.command('navigate', 'body', { value: '/settings/archived-conversations' })
        await control.command('waitFor', '[data-testid="archived-operation-error"]', { text: path })
        await writeFile(markerPath, marker)
        await remove()
        const deadline = Date.now() + uiTimeoutMs
        while (Date.now() < deadline) {
          const items = await rpc('runtime.worktrees.list', {})
          if (!items.items.some(item => item.path === path)) break
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        await assert.rejects(access(path), { code: 'ENOENT' })
        assert.equal(Number(await control.command('getElementCount', button)), 0)
        assert.equal(
          Number(
            await control.command('getElementCount', '[data-testid="archived-operation-error"]')
          ),
          0
        )
      } finally {
        // Keep the fixture repairable if an assertion fails before retry.
        if (existsSync(path)) await writeFile(markerPath, marker)
      }
    },
  }
}
