// @vitest-environment node
import { expect, test, vi } from 'vitest'
import { openPluginDevelopmentPanel } from '../../e2e/desktop/scenarios/plugin-development.scenario.mjs'

test.each(['visible', 'closed', 'tab', 'other-tab', 'restoring'])(
  'restores the real debug panel after login (initial=%s)',
  async initial => {
    const panel = '[data-testid="wework-plugin-development-sidebar"]'
    const tab = '[data-testid="right-workspace-extension-tab-wework-plugin-developer.debug"]'
    const option = '[data-testid="right-workspace-extension-option-wework-plugin-developer.debug"]'
    const shell = '[data-testid="right-workspace-panel-shell"]'
    let mounted = initial !== 'restoring'
    let open = initial !== 'closed' && initial !== 'restoring'
    let selected = initial === 'visible'
    let menu = false
    const command = vi.fn(async (action: string, selector: string) => {
      if (action === 'waitFor' && selector === shell) mounted = true
      if (action === 'getAttribute') {
        if (!mounted) throw new Error('The task workbench has not mounted after login')
        return String(!open)
      }
      if (action === 'getElementCount') {
        if (selector === panel) return Number(selected)
        if (selector === tab) return Number(initial === 'tab')
        if (selector === option)
          return Number(open && (initial === 'closed' || initial === 'restoring' || menu))
      }
      if (action === 'clickWhenEnabled') {
        if (selector.includes('toggle-right-workspace-panel-button')) open = true
        else if (selector.includes('right-workspace-new-tab-button')) menu = true
        else if (selector === tab || selector === option) {
          expect(open).toBe(true)
          selected = true
        }
      }
      if (action === 'waitFor' && selector === panel) expect(selected).toBe(true)
      return undefined
    })
    await openPluginDevelopmentPanel({ command })
    expect(selected).toBe(true)
    if (initial === 'restoring') {
      expect(command).toHaveBeenCalledWith('waitFor', shell)
      const actions = command.mock.calls.map(([action]) => action)
      expect(actions.indexOf('waitFor')).toBeLessThan(actions.indexOf('getAttribute'))
    }
    expect(command.mock.calls.filter(([action]) => action === 'clickWhenEnabled')).toHaveLength(
      initial === 'visible' ? 0 : initial === 'tab' ? 1 : 2
    )
    expect(command.mock.calls.some(([action]) => /seed|ensure|resume|start/i.test(action))).toBe(
      false
    )
  }
)
