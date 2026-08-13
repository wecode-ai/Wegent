import {
  parseQuickLaunchIntent,
  removeQuickLaunchQueryParams,
} from '@/features/tasks/components/chat/quick-launch/launch-intent'

describe('quick launch intent', () => {
  it('keeps the selected team after consuming a preset', () => {
    const params = new URLSearchParams({
      teamId: '42',
      quickLauncher: 'system:quick-site',
      quickPreset: 'internal-vote',
      agent: 'code',
    })

    expect(parseQuickLaunchIntent(params)).toEqual({
      teamId: 42,
      launcherKey: 'system:quick-site',
      presetId: 'internal-vote',
      showPresets: false,
    })

    expect(removeQuickLaunchQueryParams(params).toString()).toBe('teamId=42&agent=code')
  })
})
