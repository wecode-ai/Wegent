import { afterEach, describe, expect, it } from 'vitest'
import type { McpAppDescriptor } from '@/api/mcpApps'
import { appDisplayModes, appHostContext } from './hostContext'

const descriptor = (modes?: unknown) =>
  ({
    resource: {
      contents: [
        { uri: 'ui://app', text: '', _meta: { 'openai/ui': { availableDisplayModes: modes } } },
      ],
    },
  }) as McpAppDescriptor

afterEach(() => {
  document.documentElement.classList.remove('dark')
})

describe('MCP App host context', () => {
  it('honors explicit display mode restrictions, including unsupported-only declarations', () => {
    expect(appDisplayModes(descriptor())).toEqual(['inline', 'fullscreen', 'pip'])
    expect(appDisplayModes(descriptor(['fullscreen']))).toEqual(['fullscreen'])
    expect(appDisplayModes(descriptor(['other']))).toEqual([])
  })
  it('projects the current desktop theme and locale alongside declared modes', () => {
    const frame = document.createElement('iframe')
    document.documentElement.style.setProperty('--color-bg-base', '24 24 24')
    document.documentElement.classList.add('dark')
    const context = appHostContext(frame, 'fullscreen', descriptor(['fullscreen']), 'call')
    expect(context).toMatchObject({
      theme: 'dark',
      platform: 'desktop',
      locale: navigator.language,
      displayMode: 'fullscreen',
      availableDisplayModes: ['fullscreen'],
      styles: { variables: { '--color-background-primary': 'rgb(24 24 24)' } },
    })
  })
})
