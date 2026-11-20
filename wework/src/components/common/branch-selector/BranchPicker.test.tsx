import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import '../../../../../packages/collaboration/src/test/setup'
import { BranchPicker } from './BranchPicker'

const { t } = vi.hoisted(() => ({ t: (key: string, fallback?: string) => fallback ?? key }))
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => ({ t }) }))

it('keeps a rejected checkout recoverable and closes only after a successful checkout', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const choose = vi
    .fn()
    .mockRejectedValueOnce(new Error('Working tree has conflicts'))
    .mockResolvedValueOnce(undefined)
  const list = vi.fn(async () => ['feature'])
  const element = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  const click = async (id: string) => {
    await act(async () => {
      element(id)!.click()
    })
  }
  try {
    await act(async () => {
      root.render(
        <BranchPicker
          value="main"
          label="main"
          prefix="checkout"
          triggerTestId="checkout-trigger"
          accessibleLabel="Branch"
          onListBranches={list}
          onChoose={choose}
        />
      )
    })
    await click('checkout-trigger')
    await vi.waitFor(() => expect(element('checkout-branch-option')).not.toBeNull())
    await click('checkout-branch-option')
    await vi.waitFor(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Working tree has conflicts'
      )
    )
    expect(element('checkout-branch-menu')).not.toBeNull()
    await click('checkout-branch-retry')
    await vi.waitFor(() => expect(element('checkout-branch-option')).not.toBeNull())
    await click('checkout-branch-option')
    await vi.waitFor(() => expect(element('checkout-branch-menu')).toBeNull())
    expect(choose).toHaveBeenLastCalledWith('feature')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
