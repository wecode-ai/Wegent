import type {
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiStyles,
} from '@modelcontextprotocol/ext-apps/app-bridge'
import type { McpAppDescriptor } from '@/api/mcpApps'

export function appDisplayModes(
  descriptor: McpAppDescriptor | null | undefined
): McpUiDisplayMode[] {
  const meta = descriptor?.resource.contents[0]?._meta
  const ui = meta?.['openai/ui'] as { availableDisplayModes?: unknown } | undefined
  const modes: McpUiDisplayMode[] = ['inline', 'fullscreen', 'pip']
  const declared = ui?.availableDisplayModes
  return Array.isArray(declared) ? modes.filter(mode => declared.includes(mode)) : modes
}

export function appInitialDisplayMode(descriptor: McpAppDescriptor): McpUiDisplayMode | undefined {
  const modes = appDisplayModes(descriptor)
  const ui = descriptor.resource.contents[0]?._meta?.['openai/ui'] as
    | { availableDisplayModes?: unknown; preferredDisplayMode?: unknown }
    | undefined
  const preferred = ui?.preferredDisplayMode ?? descriptor.preferredDisplayMode
  const fallback = ui?.availableDisplayModes == null ? 'inline' : 'fullscreen'
  return modes.find(mode => mode === preferred) ?? modes.find(mode => mode === fallback) ?? modes[0]
}

export function appHostContext(
  frame: HTMLIFrameElement,
  mode: McpUiDisplayMode,
  descriptor: McpAppDescriptor,
  callId: string
): McpUiHostContext {
  const root = document.documentElement
  const tokens = getComputedStyle(root)
  const body = getComputedStyle(document.body)
  const color = (name: string) => `rgb(${tokens.getPropertyValue(name).trim()})`
  const variables: Partial<McpUiStyles> = {
    '--color-background-primary': color('--color-bg-base'),
    '--color-background-secondary': color('--color-bg-surface'),
    '--color-background-tertiary': color('--color-muted'),
    '--color-text-primary': color('--color-text-primary'),
    '--color-text-secondary': color('--color-text-secondary'),
    '--color-text-tertiary': color('--color-text-muted'),
    '--color-border-primary': color('--color-border'),
    '--color-text-info': color('--color-focus'),
    '--font-sans': body.fontFamily,
    '--font-text-md-size': body.fontSize,
  }
  return {
    theme: root.classList.contains('dark') ? 'dark' : 'light',
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: 'desktop',
    displayMode: mode,
    availableDisplayModes: appDisplayModes(descriptor),
    containerDimensions: {
      width: frame.getBoundingClientRect().width,
      maxHeight: window.innerHeight,
    },
    // The SDK documents every style variable as optional despite its Record type.
    styles: { variables: variables as McpUiStyles },
    toolInfo: descriptor.tool ? { id: callId, tool: descriptor.tool } : undefined,
  }
}
