import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export function reportDesktopStartupFailure(error: unknown, source: string): Promise<void> {
  return invokeDesktopHost<void>('renderer.startupFailed', {
    message: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
    source,
  })
}
