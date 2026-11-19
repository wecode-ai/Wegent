import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PermissionModeSelector } from './PermissionModeSelector'
import { PermissionModeSelector as SharedPermissionModeSelector } from '@wegent/collaboration/controls'
import { createInstance } from 'i18next'
import enCommon from '@/i18n/locales/en/common.json'

describe('PermissionModeSelector', () => {
  test('uses English host resources for labels and the full-access confirmation', async () => {
    const i18n = createInstance()
    await i18n.init({
      lng: 'en',
      ns: 'common',
      defaultNS: 'common',
      resources: { en: { common: enCommon } },
    })
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <SharedPermissionModeSelector
        value="workspace-write"
        onChange={onChange}
        translate={(key, fallback) => i18n.t(key, { defaultValue: fallback })}
      />
    )
    await user.click(screen.getByRole('button', { name: 'Permission mode: Workspace' }))
    expect(screen.getByTestId('permission-mode-read-only')).toHaveTextContent('Read only')
    await user.click(screen.getByTestId('permission-mode-full-access'))
    expect(screen.getByRole('alertdialog', { name: 'Turn on Full access?' })).toBeInTheDocument()
    expect(screen.getByTestId('full-access-confirm-cancel')).toHaveTextContent('Cancel')
    await user.click(screen.getByTestId('full-access-confirm-cancel'))
    expect(onChange).not.toHaveBeenCalled()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('changes between restricted modes without confirmation', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('permission-mode-read-only'))

    expect(onChange).toHaveBeenCalledWith('read-only')
  })

  test('requires confirmation before enabling full access', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('permission-mode-full-access'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()

    await user.click(screen.getByTestId('full-access-confirm-submit'))
    expect(onChange).toHaveBeenCalledWith('full-access')
  })

  test('keeps the current mode when full access is cancelled', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<PermissionModeSelector value="workspace-write" onChange={onChange} />)

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('permission-mode-full-access'))
    await user.click(screen.getByTestId('full-access-confirm-cancel'))

    expect(onChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  test('shows all three choices in the first Full access confirmation', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onCommandApprovalChange = vi.fn()
    render(
      <PermissionModeSelector
        value="workspace-write"
        onChange={onChange}
        onCommandApprovalChange={onCommandApprovalChange}
      />
    )

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('permission-mode-full-access'))

    const manual = screen.getByTestId('command-approval-confirm-option-manual')
    const ai = screen.getByTestId('command-approval-confirm-option-ai')
    const automatic = screen.getByTestId('command-approval-confirm-option-automatic')
    expect(manual).toBeChecked()
    expect(ai).toBeVisible()
    expect(automatic).toBeVisible()

    await user.click(automatic)
    expect(onChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('full-access-confirm-submit'))
    expect(onChange).toHaveBeenCalledWith('full-access', 'automatic')
    expect(onCommandApprovalChange).not.toHaveBeenCalled()
  })

  test('allows changing the approval choice inside the automatic execution confirmation', async () => {
    const user = userEvent.setup()
    const onCommandApprovalChange = vi.fn()
    render(
      <PermissionModeSelector
        value="full-access"
        commandApproval="manual"
        onChange={vi.fn()}
        onCommandApprovalChange={onCommandApprovalChange}
      />
    )

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('command-approval-automatic'))

    expect(screen.getByTestId('command-approval-confirm-option-automatic')).toBeChecked()
    await user.click(screen.getByTestId('command-approval-confirm-option-ai'))
    expect(onCommandApprovalChange).not.toHaveBeenCalled()
    await user.click(screen.getByTestId('full-access-confirm-submit'))
    expect(onCommandApprovalChange).toHaveBeenCalledWith('ai')
  })

  test('reports confirmation of the current command approval when enabling full access', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <PermissionModeSelector
        value="workspace-write"
        commandApproval="manual"
        onChange={onChange}
        onCommandApprovalChange={vi.fn()}
      />
    )

    await user.click(screen.getByTestId('permission-mode-menu-button'))
    await user.click(screen.getByTestId('permission-mode-full-access'))
    await user.click(screen.getByTestId('full-access-confirm-submit'))

    expect(onChange).toHaveBeenCalledWith('full-access', 'manual')
  })

  test('traps keyboard focus and restores it to the permission trigger', async () => {
    const user = userEvent.setup()
    render(<PermissionModeSelector value="workspace-write" onChange={vi.fn()} />)
    const trigger = screen.getByTestId('permission-mode-menu-button')

    await user.click(trigger)
    await user.click(screen.getByTestId('permission-mode-full-access'))

    const cancel = screen.getByTestId('full-access-confirm-cancel')
    const confirm = screen.getByTestId('full-access-confirm-submit')
    expect(cancel).toHaveFocus()

    await user.tab({ shift: true })
    expect(confirm).toHaveFocus()
    await user.tab()
    expect(cancel).toHaveFocus()

    await user.click(cancel)
    expect(trigger).toHaveFocus()
  })
})
