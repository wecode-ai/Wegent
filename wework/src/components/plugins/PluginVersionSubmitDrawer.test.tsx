import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginAccessResponse } from '@/types/api'
import { PluginVersionSubmitDrawer } from './PluginVersionSubmitDrawer'

const access: PluginAccessResponse = {
  pluginId: 42,
  scope: 'restricted',
  targets: [
    { entityType: 'user', entityId: '7', displayName: 'Alice' },
    { entityType: 'user', entityId: '8', displayName: 'Bob' },
    { entityType: 'namespace', entityId: '11', displayName: 'Engineering' },
  ],
  allowCopy: false,
  revocationPendingCount: 0,
}

function props() {
  return {
    pluginName: '天河直连',
    currentVersion: '1.1.0',
    nextVersion: '1.2.0',
    access,
    publishing: false,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    onManageAccess: vi.fn(),
  }
}

describe('PluginVersionSubmitDrawer', () => {
  test('shows the version change and existing scope without editable permission controls', () => {
    render(<PluginVersionSubmitDrawer {...props()} />)

    expect(screen.getByRole('dialog', { name: '提交新版本' })).toBeInTheDocument()
    expect(screen.getByTestId('plugin-version-submit-current')).toHaveTextContent('v1.1.0')
    expect(screen.getByTestId('plugin-version-submit-next')).toHaveTextContent('v1.2.0')
    expect(screen.getByTestId('plugin-version-submit-scope')).toHaveTextContent(
      '2 位成员、1 个部门'
    )
    expect(screen.getByTestId('plugin-version-submit-allow-copy')).toHaveTextContent(
      '允许复制：关闭'
    )
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.getByTestId('plugin-version-submit-preserve-version')).toHaveTextContent(
      '失败时继续使用 v1.1.0'
    )
    expect(screen.getByTestId('plugin-version-submit-notes')).toHaveFocus()
    expect(screen.getByTestId('plugin-version-submit-confirm')).toBeDisabled()
  })

  test('requires nonblank release notes, enforces the length limit and submits trimmed notes', () => {
    const onSubmit = vi.fn()
    render(<PluginVersionSubmitDrawer {...props()} onSubmit={onSubmit} />)
    const notes = screen.getByTestId('plugin-version-submit-notes')
    const submit = screen.getByTestId('plugin-version-submit-confirm')

    expect(notes).toHaveAttribute('maxlength', '2000')
    fireEvent.change(notes, { target: { value: '   ' } })
    expect(notes).toHaveAttribute('aria-invalid', 'true')
    expect(submit).toBeDisabled()
    fireEvent.change(notes, { target: { value: 'x'.repeat(2001) } })
    expect(submit).toBeDisabled()
    fireEvent.change(notes, { target: { value: '  新增排期查询。  ' } })
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('新增排期查询。')
  })

  test('keeps notes through a failed submission and allows retry with the same notes', () => {
    const options = props()
    const { rerender } = render(<PluginVersionSubmitDrawer {...options} />)
    fireEvent.change(screen.getByTestId('plugin-version-submit-notes'), {
      target: { value: '新增排期查询。' },
    })
    fireEvent.click(screen.getByTestId('plugin-version-submit-confirm'))
    rerender(<PluginVersionSubmitDrawer {...options} publishing />)
    expect(screen.getByTestId('plugin-version-submit-confirm')).toHaveTextContent('正在检查并提交…')

    rerender(<PluginVersionSubmitDrawer {...options} error="扫描失败，请重试。" />)
    expect(screen.getByRole('alert')).toHaveTextContent('扫描失败，请重试。')
    expect(screen.getByTestId('plugin-version-submit-notes')).toHaveValue('新增排期查询。')
    fireEvent.click(screen.getByTestId('plugin-version-submit-confirm'))
    expect(options.onSubmit).toHaveBeenCalledTimes(2)
    expect(options.onSubmit).toHaveBeenLastCalledWith('新增排期查询。')
  })

  test('blocks dismissal and permission changes while submitting', async () => {
    const options = props()
    render(<PluginVersionSubmitDrawer {...options} publishing initialReleaseNotes="改进查询" />)

    expect(screen.getByRole('dialog')).toHaveFocus()
    for (const action of ['close', 'cancel', 'confirm', 'manage-access']) {
      expect(screen.getByTestId(`plugin-version-submit-${action}`)).toBeDisabled()
      fireEvent.click(screen.getByTestId(`plugin-version-submit-${action}`))
    }
    await userEvent.keyboard('{Escape}')
    fireEvent.click(screen.getByTestId('plugin-version-submit-overlay'))
    expect(options.onClose).not.toHaveBeenCalled()
    expect(options.onManageAccess).not.toHaveBeenCalled()
    expect(options.onSubmit).not.toHaveBeenCalled()
  })

  test('passes its draft to sharing management and restores a supplied draft', () => {
    const options = props()
    render(<PluginVersionSubmitDrawer {...options} initialReleaseNotes="  改进查询  " />)
    expect(screen.getByTestId('plugin-version-submit-notes')).toHaveValue('  改进查询  ')
    fireEvent.click(screen.getByTestId('plugin-version-submit-manage-access'))
    expect(options.onManageAccess).toHaveBeenCalledExactlyOnceWith('  改进查询  ')
  })

  test('traps keyboard focus, dismisses on Escape and restores focus to its trigger', async () => {
    const options = props()
    const trigger = document.createElement('button')
    document.body.append(trigger)
    trigger.focus()
    const { unmount } = render(
      <PluginVersionSubmitDrawer {...options} initialReleaseNotes="改进查询" />
    )
    screen.getByTestId('plugin-version-submit-confirm').focus()
    await userEvent.tab()
    expect(screen.getByTestId('plugin-version-submit-close')).toHaveFocus()
    await userEvent.tab({ shift: true })
    expect(screen.getByTestId('plugin-version-submit-confirm')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(options.onClose).toHaveBeenCalledOnce()
    unmount()
    expect(trigger).toHaveFocus()
    trigger.remove()
  })

  test('shows private scope and enabled copying from the supplied access state', () => {
    render(
      <PluginVersionSubmitDrawer
        {...props()}
        access={{ ...access, scope: 'private', targets: [], allowCopy: true }}
      />
    )
    expect(screen.getByTestId('plugin-version-submit-scope')).toHaveTextContent('仅自己可用')
    expect(screen.getByTestId('plugin-version-submit-allow-copy')).toHaveTextContent(
      '允许复制：开启'
    )
  })
})
