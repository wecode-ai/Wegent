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
  'src/extensions/device-surface-contract.ts',
  'src/lib/external-links.ts',
]
const vncImplementationToken = /vnc|\bRFB\b|prepare_vnc_session|get_vnc_session_config/i

describe('VNC code ownership', () => {
  test.each(publicIntegrationFiles)('keeps VNC implementation out of %s', fileName => {
    const source = readFileSync(resolve(weworkDirectory, fileName), 'utf8')

    expect(source).not.toMatch(vncImplementationToken)
  })

  test('keeps connection and launch implementation out of the public cloud desktop contract', () => {
    const publicContract = readFileSync(
      resolve(weworkDirectory, 'src/extensions/device-surface-contract.ts'),
      'utf8'
    )

    expect(publicContract).not.toContain('CloudDesktopConnection')
    expect(publicContract).not.toContain('CloudDesktopOpenTarget')
    expect(publicContract).not.toContain('OpenCloudDesktopOptions')
    expect(publicContract).not.toMatch(/\bopen:/)
  })

  test('keeps VNC translations in the Wecode namespace', () => {
    const publicChinese = readFileSync(
      resolve(weworkDirectory, 'src/i18n/locales/zh-CN/common.json'),
      'utf8'
    )
    const publicEnglish = readFileSync(
      resolve(weworkDirectory, 'src/i18n/locales/en/common.json'),
      'utf8'
    )
    const wecodeChinese = readFileSync(
      resolve(weworkDirectory, 'wecode/i18n/locales/zh-CN/vnc.json'),
      'utf8'
    )
    const wecodeEnglish = readFileSync(
      resolve(weworkDirectory, 'wecode/i18n/locales/en/vnc.json'),
      'utf8'
    )

    expect(publicChinese).not.toContain('connection_device_desktop')
    expect(publicEnglish).not.toContain('connection_device_desktop')
    expect(wecodeChinese).toContain('open_system_desktop_failed')
    expect(wecodeEnglish).toContain('open_system_desktop_failed')
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
    const taskFlowMainSource = readFileSync(
      resolve(weworkDirectory, 'e2e/desktop/modules/task-flow-main.mjs'),
      'utf8'
    )
    const wecodeEntrySource = readFileSync(
      resolve(weworkDirectory, 'wecode/e2e/desktop/task-flow.e2e.mjs'),
      'utf8'
    )
    const packageJson = JSON.parse(
      readFileSync(resolve(weworkDirectory, 'package.json'), 'utf8')
    ) as { scripts?: Record<string, string> }

    expect(taskFlowSource).toContain("import { main } from './modules/task-flow-main.mjs'")
    expect(taskFlowMainSource).toContain('WEWORK_E2E_DESKTOP_SCENARIO_MODULE')
    expect(taskFlowMainSource).not.toContain('createWecodeDesktopScenario')
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
