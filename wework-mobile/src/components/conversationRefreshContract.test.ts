import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sources = import.meta.glob(['./ConversationListScreen.tsx', '../../App.tsx'], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('conversation refresh contract', () => {
  it('pulls only through the current runtime refresh without replacing cached rows', () => {
    const screen = sources['./ConversationListScreen.tsx']
    const app = sources['../../App.tsx']

    expect(screen).toContain('<RefreshControl')
    expect(screen).toContain('onRefresh={() => void props.onRefresh()}')
    expect(screen).toContain('refreshing={props.refreshing}')
    expect(screen).toContain('testID="conversation-list-refresh"')
    expect(app).toContain('onRefresh={runtime.refresh}')
    expect(app).toContain('refreshing={runtime.refreshing}')
  })

  it('separates the all-device task scope from offline-device visibility', () => {
    const screen = sources['./ConversationListScreen.tsx']
    const app = sources['../../App.tsx']

    expect(screen).toContain('accessibilityLabel="显示所有设备任务"')
    expect(screen).toContain('onPress={props.onSelectAllDevices}')
    expect(screen).toContain('testID="drawer-toggle-offline-devices"')
    expect(screen).toContain("label={showAllDevices ? '仅显示在线设备' : '显示全部设备'}")
    expect(app).toContain('onSelectAllDevices={runtime.selectAllDevices}')
  })

  it('separates projects and standalone tasks into collapsible sections', () => {
    const screen = sources['./ConversationListScreen.tsx']

    expect(screen).toContain("title: '项目'")
    expect(screen).toContain("title: '任务'")
    expect(screen).toContain('onPress={() => toggleSection(item.section)}')
    expect(screen).toContain('testID={`section-${item.section}-toggle`}')
    expect(screen).toContain('accessibilityState={{ expanded: item.expanded }}')
  })
})
