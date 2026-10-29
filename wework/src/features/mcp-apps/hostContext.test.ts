import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpAppDescriptor } from '@/api/mcpApps'
import { appDisplayModes, appHostContext, appInitialDisplayMode } from './hostContext'

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
  it('reports the right panel bounds instead of the whole window', () => {
    const frame = document.createElement('iframe')
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue({ width: 640, height: 480 } as DOMRect)
    expect(
      appHostContext(frame, 'fullscreen', descriptor(), 'call').containerDimensions
    ).toMatchObject({
      maxWidth: 640,
      maxHeight: 480,
    })
  })
  it('honors explicit display mode restrictions, including unsupported-only declarations', () => {
    expect(appDisplayModes(descriptor())).toEqual(['inline', 'fullscreen', 'pip'])
    expect(appDisplayModes(descriptor(['fullscreen']))).toEqual(['fullscreen'])
    expect(appDisplayModes(descriptor(['other']))).toEqual([])
  })
  it('selects the same initial modes as the ChatGPT host', () => {
    expect(appInitialDisplayMode(descriptor())).toBe('inline')
    expect(appInitialDisplayMode(descriptor(['inline', 'fullscreen']))).toBe('fullscreen')
    expect(appInitialDisplayMode(descriptor(['inline', 'pip']))).toBe('inline')
    expect(appInitialDisplayMode(descriptor(['fullscreen']))).toBe('fullscreen')
    expect(appInitialDisplayMode(descriptor(['other']))).toBeUndefined()
    const app = descriptor(['inline', 'fullscreen'])
    app.preferredDisplayMode = 'inline'
    expect(appInitialDisplayMode(app)).toBe('inline')
    app.resource.contents[0]._meta!['openai/ui'] = {
      availableDisplayModes: ['inline', 'fullscreen'],
      preferredDisplayMode: 'fullscreen',
    }
    expect(appInitialDisplayMode(app)).toBe('fullscreen')
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
