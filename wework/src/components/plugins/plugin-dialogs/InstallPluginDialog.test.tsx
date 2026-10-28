import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import '@/i18n'
import type { PluginDistribution } from '../pluginDistribution'
import { InstallPluginDialog } from './InstallPluginDialog'

test.each<[PluginDistribution, boolean]>([
  ['official', true],
  ['public', true],
  ['public', false],
  ['workspace', false],
  ['personal', false],
  ['external', false],
])(
  'shows a warning and focuses cancel for distribution %s with official provenance %s',
  async (distribution, official) => {
    const onCancel = vi.fn()
    const onConfirm = vi.fn()
    render(
      <InstallPluginDialog
        plugin={{
          id: 'sample',
          name: 'Sample',
          componentCount: 1,
          logoDistribution: distribution,
          isOfficial: official,
        }}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />
    )
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
