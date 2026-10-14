import { expect, test, vi } from 'vitest'
import { installStartupExceptionMonitor } from './startup-exception-monitor.js'

test('observes startup errors without changing uncaught handlers or exposing exception data', () => {
  const report = vi.fn()
  const handlers = process.listeners('uncaughtException')
  const monitors = process.listeners('uncaughtExceptionMonitor')
  const remove = installStartupExceptionMonitor(report)
  try {
    const error = new ReferenceError('http://private.invalid/private-path?token=private-token')
    error.name = 'private-error-name'
    process.emit('uncaughtExceptionMonitor', error, 'uncaughtException')
    process.emit('uncaughtExceptionMonitor', new SyntaxError('private-json'), 'unhandledRejection')
    const generic = new Error('private-generic-message')
    generic.name = 'private-generic-name'
    process.emit('uncaughtExceptionMonitor', generic, 'uncaughtException')
    expect(report.mock.calls).toEqual([
      [{ errorKind: 'ReferenceError', origin: 'uncaughtException' }],
      [{ errorKind: 'SyntaxError', origin: 'unhandledRejection' }],
      [{ errorKind: 'Error', origin: 'uncaughtException' }],
    ])
    expect(process.listeners('uncaughtException')).toEqual(handlers)
  } finally {
    remove()
  }
  expect(process.listeners('uncaughtExceptionMonitor')).toEqual(monitors)
  process.emit(
    'uncaughtExceptionMonitor',
    new TypeError('private-after-remove'),
    'uncaughtException'
  )
  expect(report).toHaveBeenCalledTimes(3)
})
