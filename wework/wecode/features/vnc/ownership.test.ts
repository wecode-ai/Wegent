import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const weworkDirectory = resolve(import.meta.dirname, '../../..')
const publicIntegrationFiles = [
  'vite.config.ts',
  'src/e2e/automation.ts',
  'e2e/desktop/task-flow.e2e.mjs',
  'src/components/layout/DesktopWorkbenchLayout.test.tsx',
]
const vncImplementationToken = /vnc|\bRFB\b|prepare_vnc_session|get_vnc_session_config/i

describe('VNC code ownership', () => {
  test.each(publicIntegrationFiles)('keeps VNC implementation out of %s', fileName => {
    const source = readFileSync(resolve(weworkDirectory, fileName), 'utf8')

    expect(source).not.toMatch(vncImplementationToken)
  })

  test('exposes embedded-browser evaluation as a generic desktop control action', () => {
    const source = readFileSync(resolve(weworkDirectory, 'src/e2e/automation.ts'), 'utf8')

    expect(source).toContain("| 'evalEmbeddedBrowserJson'")
    expect(source).toContain("throw new Error('evalEmbeddedBrowserJson requires an expression')")
  })

  test('provides a focused generic Wecode Desktop E2E scenario', () => {
    const taskFlowSource = readFileSync(
      resolve(weworkDirectory, 'e2e/desktop/task-flow.e2e.mjs'),
      'utf8'
    )
    const packageJson = JSON.parse(
      readFileSync(resolve(weworkDirectory, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }

    expect(taskFlowSource).toContain("const WECODE_ONLY = process.argv.includes('--wecode-only')")
    expect(taskFlowSource).toContain('if (WECODE_ONLY)')
    expect(packageJson.scripts?.['e2e:desktop:wecode']).toBe(
      'node e2e/desktop/task-flow.e2e.mjs --wecode-only'
    )
  })
})
