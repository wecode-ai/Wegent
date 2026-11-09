import { expect, test, vi } from 'vitest'
import { desktopInstanceMayStart } from './plugin-development-command.js'

test.each([false, true])(
  'command-only process cannot start a desktop (receiver exited=%s)',
  owns => {
    const app = {
      releaseSingleInstanceLock: vi.fn(),
      exit: vi.fn(),
    }
    const start = vi.fn()
    if (desktopInstanceMayStart(app, owns, 'python-login')) start()
    expect(start).not.toHaveBeenCalled()
    expect(app.exit).toHaveBeenCalledTimes(owns ? 1 : 0)
    expect(app.releaseSingleInstanceLock).toHaveBeenCalledTimes(owns ? 1 : 0)
    if (owns) expect(app.exit).toHaveBeenCalledWith(0)
  }
)

test.each([false, true])('ordinary launches retain singleton ownership=%s', owns => {
  const app = {
    releaseSingleInstanceLock: vi.fn(),
    exit: vi.fn(),
  }
  expect(desktopInstanceMayStart(app, owns, null)).toBe(owns)
  expect(app.exit).not.toHaveBeenCalled()
  expect(app.releaseSingleInstanceLock).not.toHaveBeenCalled()
})
