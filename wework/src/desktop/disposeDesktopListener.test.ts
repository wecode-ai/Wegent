import { describe, expect, test, vi } from 'vitest'
import { disposeDesktopListener } from './disposeDesktopListener'

describe('disposeDesktopListener', () => {
  test('handles asynchronous cleanup failures without creating an unhandled rejection', async () => {
    const error = new Error('listener already removed')
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)

    disposeDesktopListener((() => Promise.reject(error)) as unknown as () => void, 'test')
    await vi.waitFor(() =>
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('test'), error)
    )

    debug.mockRestore()
  })
})
