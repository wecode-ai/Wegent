import '@/i18n'
import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { DeletePersonalPluginDialog } from './DeletePersonalPluginDialog'

describe('DeletePersonalPluginDialog', () => {
  test('waits for published plugin usage impact before enabling deletion', () => {
    render(
      <DeletePersonalPluginDialog
        pluginName="Dev Tools"
        installed={false}
        published
        impact={null}
        deleting={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText('正在检查插件的使用情况…')).toBeInTheDocument()
    expect(screen.getByTestId('plugin-delete-confirm-button')).toBeDisabled()
    expect(screen.getByTestId('plugin-delete-cancel-button')).toBeEnabled()
  })
})
