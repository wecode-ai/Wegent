// @vitest-environment node
import { expect, test } from 'vitest'
import { selectSuites, validateOptions, waitForSinglePage } from './ai-verify-bombadil.mjs'
import { resolveElectronLaunch, validateStartOptions } from './ai-verify.mjs'

test('selects the union of affected features and identifies uncovered code', () => {
  expect(
    selectSuites([
      'wework/src/features/appearance/storage.ts',
      'wework/src/components/layout/DesktopSidebar.tsx',
      'wework/src/api/local/tasks.ts',
      'docs/zh/README.md',
    ])
  ).toEqual({ suites: ['appearance', 'workbench'], uncovered: ['wework/src/api/local/tasks.ts'] })
  expect(selectSuites(['wework/src/components/ui/button.tsx']).suites).toEqual([
    'appearance',
    'workbench',
  ])
  expect(selectSuites(['docs/en/README.md'])).toEqual({ suites: [], uncovered: [] })
})
test('rejects unknown suites and invalid budgets before launching an application', () => {
  for (const seconds of ['0', '-1', '601', 'NaN', '1.5'])
    expect(() => validateOptions({ seconds })).toThrow()
  expect(() => validateOptions({ suite: '../other' })).toThrow('Unknown suite')
  expect(() => validateOptions({ plan: 'yes' })).toThrow()
  expect(() => validateOptions({ unexpected: 'true' })).toThrow()
  expect(validateOptions({ suite: 'appearance' })).toBe(30)
})
test('opens an ephemeral loopback debugger only for explicit isolated exploration', () => {
  expect(resolveElectronLaunch({ packaged: false, sourceBinary: '/electron' }).args).toEqual(['.'])
  expect(
    resolveElectronLaunch({ packaged: false, sourceBinary: '/electron', bombadil: true }).args
  ).toEqual(['.', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'])
  expect(() => validateStartOptions({ bombadil: 'true', 'executor-home': '/existing' })).toThrow(
    'isolated'
  )
  expect(() => validateStartOptions({ bombadil: 'invalid' })).toThrow()
})

test('waits for the startup splash to close instead of choosing an arbitrary page', async () => {
  const main = { url: 'http://127.0.0.1:1234/' }
  let reads = 0
  const page = await waitForSinglePage(
    async () => (++reads === 1 ? [{ url: 'file:///splash' }, main] : [main]),
    { poll: async () => {} }
  )
  expect(reads).toBe(2)
  expect(page).toBe(main)
  await expect(waitForSinglePage(async () => [], { timeoutMs: 0 })).rejects.toThrow(
    'Expected one isolated page'
  )
})
