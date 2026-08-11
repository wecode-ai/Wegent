import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { PluginPublishDialog } from './PluginPublishDialog'

describe('PluginPublishDialog', () => {
  test('offers share recovery when version conflict recovery is enabled', () => {
    const onShareRecovery = vi.fn()
    render(
      <PluginPublishDialog
        pluginName="Dev Tools"
        canPublish={false}
        canSharePersonal
        publishing={false}
        error="该版本已存在，请先在插件清单中提升 version 后再发布。"
        shareRecoveryLabel="去分享成员"
        onShareRecovery={onShareRecovery}
        onClose={vi.fn()}
        onPublish={vi.fn()}
        searchUsers={async () => []}
        searchGroups={async () => []}
      />
    )

    fireEvent.click(screen.getByTestId('plugin-publish-share-recovery'))
    expect(onShareRecovery).toHaveBeenCalledTimes(1)
  })
})
