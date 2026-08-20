import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'

import { WorkbenchRootFrame } from '@/plugins/WorkbenchRootFrame'

import { WorkbenchSlotRegistry } from './slots'

describe('WorkbenchSlotRegistry', () => {
  test('renders contributed shell slots and removes them through the disposer', async () => {
    const slots = new WorkbenchSlotRegistry()
    slots.register({
      name: 'root',
      component: WorkbenchRootFrame,
      children: {
        'wework.shell.before': { kind: 'list', scope: 'root' },
        'wework.shell.after': { kind: 'list', scope: 'root' },
        'wework.shell.overlay': { kind: 'list', scope: 'root' },
      },
    })
    const dispose = slots.register({
      name: 'wework.shell.overlay',
      id: 'test-overlay',
      component: () => <div>plugin overlay</div>,
    })

    const view = render(slots.renderRoot(<main>workbench</main>))
    expect(screen.getByText('workbench')).toBeInTheDocument()
    expect(screen.getByText('plugin overlay')).toBeInTheDocument()

    dispose()
    await Promise.resolve()
    view.rerender(slots.renderRoot(<main>workbench</main>))
    expect(screen.queryByText('plugin overlay')).not.toBeInTheDocument()
  })

  test('rejects contributions to undeclared slots', () => {
    const slots = new WorkbenchSlotRegistry()
    expect(() =>
      slots.register({
        name: 'wework.shell.overlay',
        id: 'orphan',
        component: () => null,
      })
    ).toThrow(/not declared/)
  })
})
