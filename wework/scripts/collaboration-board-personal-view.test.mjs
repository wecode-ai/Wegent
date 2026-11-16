// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { openProjectBoard } from '../e2e/desktop/modules/collaboration-board-personal-view.mjs'
import { DEFAULT_STEP_TIMEOUT_MS } from '../e2e/desktop/modules/shared.mjs'

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${content} ${selector}`

test.each([true, false])(
  'opens the board using the mounted navigation control (compact=%s)',
  async compact => {
    const command = vi.fn(async (action, selector) => {
      if (action === 'getAttribute') return 'true'
      if (action === 'getElementCount') return compact ? '1' : '0'
      if (
        compact &&
        action !== 'chooseWhenEnabled' &&
        selector.endsWith('[data-testid="collaboration-tab-board"]')
      ) {
        throw new Error('Expanded tabs are not mounted in compact layout')
      }
      return ''
    })
    await openProjectBoard({ command }, scoped, {
      id: 'project',
      name: 'Project',
      workspace_id: 'workspace',
    })
    expect(command).toHaveBeenCalledWith(
      'chooseWhenEnabled',
      `${scoped('[data-testid="collaboration-project-view-select"]')}, ${scoped('[data-testid="collaboration-tab-board"]')}`,
      { value: 'board', visible: true, timeoutMs: DEFAULT_STEP_TIMEOUT_MS }
    )
    expect(command).toHaveBeenLastCalledWith(
      'waitFor',
      scoped('[data-testid="collaboration-board"]')
    )
  }
)
