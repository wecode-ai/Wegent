import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
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

  test('shows affected users and requires disable-and-delete confirmation', () => {
    render(
      <DeletePersonalPluginDialog
        pluginName="Dev Tools"
        installed={false}
        published
        impact={{
          pluginId: 19,
          affectedUserCount: 2,
          installedDeviceCount: 3,
          sharedTargetCount: 4,
          impactRevision: '2026-08-14T10:00:00',
        }}
        deleting={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText(/当前有 2 位其他用户安装/)).toHaveTextContent('3 台设备')
    expect(screen.getByText(/当前有 2 位其他用户安装/)).toHaveTextContent('4 个对象')
    expect(screen.getByTestId('plugin-delete-confirm-button')).toHaveTextContent('停用并删除')
  })

  test('explains that an active publication is withdrawn before deletion', () => {
    render(
      <DeletePersonalPluginDialog
        pluginName="Dev Tools"
        installed
        published={false}
        publicationActive
        impact={null}
        deleting={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    )

    expect(screen.getByText(/仍有进行中的企业全员发布申请/)).toHaveTextContent(
      '只有撤回成功才会继续删除个人插件'
    )
    expect(screen.getByTestId('plugin-delete-confirm-button')).toHaveTextContent('撤回申请并删除')
  })
})
