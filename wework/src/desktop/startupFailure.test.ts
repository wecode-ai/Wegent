import { expect, test, vi } from 'vitest'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { reportDesktopStartupFailure } from './startupFailure'

vi.mock('@/api/dsh/desktopHost', () => ({ invokeDesktopHost: vi.fn().mockResolvedValue(null) }))

test('reports the original renderer exception and its initialization source', async () => {
  const error = new Error('Storage initialization failed')
  await reportDesktopStartupFailure(error, 'renderer_mount')
  expect(invokeDesktopHost).toHaveBeenCalledWith('renderer.startupFailed', {
    message: error.message,
    stack: error.stack,
    source: 'renderer_mount',
  })
})
