import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginDistribution } from '../pluginDistribution'
import { InstallPluginDialog } from './InstallPluginDialog'

test.each<PluginDistribution>(['official', 'public', 'workspace', 'personal', 'external'])(
  'shows a warning and focuses cancel only for unofficial distribution %s',
  async distribution => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <InstallPluginDialog
        plugin={{ id: 'sample', name: 'Sample', componentCount: 1, logoDistribution: distribution }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    )
    const official = distribution === 'official' || distribution === 'public'
    expect(Boolean(screen.queryByTestId('plugin-install-unofficial-warning'))).toBe(!official)
    expect(
      screen.getByTestId(
        official ? 'install-plugin-dialog-confirm' : 'install-plugin-dialog-cancel'
      )
    ).toHaveFocus()
    expect(onConfirm).not.toHaveBeenCalled()
    await userEvent.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
  }
)
