import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import type { MessageCenterSnapshot } from '@/api/standInMessageCenter'
import '@/i18n'
import { StandInMessageCenter } from './StandInMessageCenter'

it('preserves a template edit when pausing a source advances the policy version', async () => {
  const user = userEvent.setup()
  const settings = {
    version: 5,
    sourceIds: ['group'],
    templates: { document: true, confirmedLogistics: true, standardProcess: true },
  }
  const snapshot: MessageCenterSnapshot = {
    identity: { id: 'dingtalk-account', account: '测试账号', organization: '测试组织' },
    deviceName: 'This Mac',
    updatedAt: null,
    status: 'paused',
    records: [],
    sources: [{ id: 'group', name: '项目讨论群', kind: 'group', paused: false, included: true }],
    settings,
    capabilities: ['saveSettings', 'setSourcePaused'],
  }
  const onCommand = vi.fn(async () => true)
  const renderCenter = (value: MessageCenterSnapshot) => (
    <StandInMessageCenter
      snapshot={value}
      loading={false}
      error={false}
      actionError={false}
      busy={false}
      onCommand={onCommand}
      onOpenSettings={vi.fn()}
      onRefresh={vi.fn()}
    />
  )
  const { rerender } = render(renderCenter(snapshot))

  await user.click(screen.getByTestId('message-center-open-settings'))
  await user.click(screen.getByTestId('message-center-template-document'))
  await user.click(screen.getByTestId('message-center-settings-pause-source-group'))
  expect(onCommand).toHaveBeenCalledExactlyOnceWith({
    type: 'setSourcePaused',
    sourceId: 'group',
    paused: true,
  })

  rerender(
    renderCenter({
      ...snapshot,
      settings: { ...settings, version: 6 },
      sources: [{ ...snapshot.sources[0], paused: true }],
    })
  )

  await user.click(screen.getByTestId('message-center-settings-save'))

  expect(onCommand).toHaveBeenLastCalledWith({
    type: 'saveSettings',
    settings: { ...settings, version: 6, templates: { ...settings.templates, document: false } },
  })
})
