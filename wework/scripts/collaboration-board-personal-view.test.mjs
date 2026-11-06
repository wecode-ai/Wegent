// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { openProjectBoard } from '../e2e/desktop/modules/collaboration-board-personal-view.mjs'

const content = '[data-workspace-tab-content][aria-hidden="false"]'
const scoped = selector => `${content} ${selector}`

test.each([true, false])(
  'opens the board using the mounted navigation control (compact=%s)',
  async compact => {
    let selected
    const command = vi.fn(async (action, selector, options) => {
      if (action === 'getAttribute') return 'true'
      if (action === 'chooseWhenEnabled') {
        const mounted = compact ? 'collaboration-project-view-select' : 'collaboration-tab-board'
        expect(selector.split(', ')).toContain(scoped(`[data-testid="${mounted}"]`))
        selected = options.value
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
      { value: 'board', timeoutMs: expect.any(Number) }
    )
    expect(selected).toBe('board')
    expect(command).toHaveBeenLastCalledWith(
      'waitFor',
      scoped('[data-testid="collaboration-board"]')
    )
  }
)
