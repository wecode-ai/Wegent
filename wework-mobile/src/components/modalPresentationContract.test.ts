import { describe, expect, it } from 'vitest'

declare global {
  interface ImportMeta {
    glob(
      pattern: string | string[],
      options: { eager: true; import: 'default'; query: '?raw' }
    ): Record<string, string>
  }
}

const sourceModules = import.meta.glob(['./ConversationScreen.tsx', '../../App.tsx'], {
  eager: true,
  import: 'default',
  query: '?raw',
}) as Record<string, string>

describe('modal presentation contract', () => {
  it('does not move a transparent modal backdrop with the native slide animation', () => {
    const conversationSource = sourceModules['./ConversationScreen.tsx']

    expect(conversationSource).not.toContain('<Modal animationType="slide"')
    expect(conversationSource).toContain('animationType="none"')
    expect(conversationSource).toContain('presentationStyle="overFullScreen"')
  })

  it('uses a non-translating transition for transparent navigation modals', () => {
    const appSource = sourceModules['../../App.tsx']
    const modelPickerOptions = appSource.slice(
      appSource.indexOf('name="modelPicker"'),
      appSource.indexOf('</RuntimeStack.Screen>', appSource.indexOf('name="modelPicker"'))
    )

    expect(modelPickerOptions).toContain("animation: 'fade'")
    expect(modelPickerOptions).not.toContain("animation: 'slide_from_right'")
  })
})
