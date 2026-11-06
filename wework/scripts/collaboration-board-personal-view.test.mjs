// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { openProjectBoard } from '../e2e/desktop/modules/collaboration-board-personal-view.mjs'

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${content} ${selector}`

test('opens the board through the responsive navigation choice', async () => {
  const command = vi.fn(async action => (action === 'getAttribute' ? 'true' : ''))
  await openProjectBoard({ command }, scoped, {
    id: 'project',
    name: 'Project',
    workspace_id: 'workspace',
  })
  expect(command).toHaveBeenCalledWith(
    'chooseWhenEnabled',
    scoped('[data-testid="collaboration-project-view-select"]') +
      ', ' +
      scoped('[data-testid="collaboration-tab-board"]'),
    { value: 'board', timeoutMs: expect.any(Number) }
  )
  expect(command).toHaveBeenLastCalledWith('waitFor', scoped('[data-testid="collaboration-board"]'))
})
