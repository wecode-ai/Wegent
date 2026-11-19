import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import type { McpAppDescriptor } from '@/api/mcpApps'

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export interface AppDocument {
  id: string
  url: string
  release: () => Promise<void>
}

export type SessionAppDescriptor = McpAppDescriptor & { sessionId: string }

export async function createAppDocument(
  html: string,
  metadata: Record<string, unknown>,
  sessionId: string
): Promise<AppDocument> {
  const document = await invokeDesktopHost<{ id: string; url: string }>('mcpApps.createDocument', {
    html,
    metadata,
    sessionId,
  })
  let released: Promise<void> | undefined
  return {
    ...document,
    release: () =>
      (released ??= invokeDesktopHost<void>('mcpApps.releaseDocument', { id: document.id }).catch(
        error => {
          released = undefined
          throw error
        }
      )),
  }
}
