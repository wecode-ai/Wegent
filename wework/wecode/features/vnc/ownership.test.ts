import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const weworkDirectory = resolve(import.meta.dirname, '../../..')
const publicIntegrationFiles = [
  'vite.config.ts',
  'src/e2e/automation.ts',
  'e2e/desktop/task-flow.e2e.mjs',
  'src/components/layout/workspace-panels/WorkspacePanelCards.test.tsx',
  'src/components/layout/DesktopWorkbenchLayout.test.tsx',
  'src/components/settings/ConnectionsSettingsPage.test.tsx',
]
const vncImplementationToken = /vnc|\bRFB\b|prepare_vnc_session|get_vnc_session_config/i

describe('VNC code ownership', () => {
  test.each(publicIntegrationFiles)('keeps VNC implementation out of %s', fileName => {
    const source = readFileSync(resolve(weworkDirectory, fileName), 'utf8')

    expect(source).not.toMatch(vncImplementationToken)
  })

  test('delegates Wecode browser commands through the desktop control extension', () => {
    const publicSource = readFileSync(resolve(weworkDirectory, 'src/e2e/automation.ts'), 'utf8')
    const wecodeSource = readFileSync(
      resolve(weworkDirectory, 'wecode/extensions/desktop-control.ts'),
      'utf8'
    )

    expect(publicSource).toContain('desktopControlExtension.execute(command)')
    expect(publicSource).not.toContain("case 'evalEmbeddedBrowserJson'")
    expect(publicSource).not.toContain("case 'prepareEmbeddedBrowserRelabelRegression'")
    expect(wecodeSource).toContain("case 'evalEmbeddedBrowserJson'")
    expect(wecodeSource).toContain("case 'prepareEmbeddedBrowserRelabelRegression'")
  })

  test('provides a focused generic Wecode Desktop E2E scenario', () => {
    const taskFlowSource = readFileSync(
      resolve(weworkDirectory, 'e2e/desktop/task-flow.e2e.mjs'),
      'utf8'
    )
    const wecodeEntrySource = readFileSync(
      resolve(weworkDirectory, 'wecode/e2e/desktop/task-flow.e2e.mjs'),
      'utf8'
    )
    const packageJson = JSON.parse(
      readFileSync(resolve(weworkDirectory, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }

    expect(taskFlowSource).toContain('WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
    expect(taskFlowSource).not.toContain('createWecodeDesktopScenario')
    expect(wecodeEntrySource).toContain('WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
    expect(wecodeEntrySource).toContain("await import('../../../e2e/desktop/task-flow.e2e.mjs')")
    expect(packageJson.scripts?.['e2e:desktop:wecode']).toBe(
      'node wecode/e2e/desktop/task-flow.e2e.mjs'
    )
    expect(
      existsSync(resolve(weworkDirectory, 'wecode/features/vnc/WorkspaceDesktopAction.test.tsx'))
    ).toBe(true)
    expect(existsSync(resolve(weworkDirectory, 'wecode/e2e/desktop-control.test.ts'))).toBe(true)
  })
})
