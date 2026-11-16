import { expect, test } from 'vitest'
import { buildStartupDiagnostics } from './startup-diagnostics.js'
import { startupFailureSnapshot } from './startup-failure.js'

test('renderer failure remains authoritative without a runtime error', async () => {
  const error = new Error('Workbench failed to mount')
  const failure = startupFailureSnapshot(
    { message: error.message, stack: error.stack },
    { source: 'renderer_mount', stage: 'renderer' }
  )
  const diagnostics = await buildStartupDiagnostics({
    appName: 'Wework',
    appVersion: 'test',
    platform: 'win32',
    arch: 'x64',
    nodeVersion: '24',
    logDirectories: [],
    progress: { current: null, history: [] },
    failure,
    runtimeError: null,
  })

  expect(diagnostics).toContain('Startup failed: Workbench failed to mount')
  expect(diagnostics).toContain(error.stack)
  expect(diagnostics).toContain('Source: renderer_mount')
  expect(diagnostics).toContain('Stage: renderer')
  expect(diagnostics).not.toContain('Startup is in progress')
})

test('retains native error context and non-Error startup failures', () => {
  const error = new Error('Core plugin failed')
  expect(startupFailureSnapshot(error, { source: 'core_plugin', pluginName: 'plugin-a' })).toEqual({
    message: error.message,
    stack: error.stack,
    source: 'core_plugin',
    pluginName: 'plugin-a',
  })
  expect(startupFailureSnapshot('runtime unavailable', { source: 'desktop_runtime' })).toEqual({
    message: 'runtime unavailable',
    source: 'desktop_runtime',
  })
})
