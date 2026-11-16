import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { UninstallPluginDialog } from './UninstallPluginDialog'

describe('UninstallPluginDialog', () => {
  test.each([
    ['local', '将从本机卸载，之后可重新安装'],
    ['account', '将从当前账号卸载，并同步移除设备上的安装'],
    ['published-source', '源码、已分享版本和分享范围会保留'],
  ] as const)('describes the %s uninstall scope', (scope, description) => {
    render(
      <UninstallPluginDialog
        pluginName="Dev Tools"
        scope={scope}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByTestId('uninstall-plugin-dialog')).toHaveTextContent(description)
    expect(screen.getByTestId('plugin-uninstall-cancel-button')).toHaveFocus()
    expect(screen.getByTestId('plugin-uninstall-confirm-button')).toBeEnabled()
  })
})
