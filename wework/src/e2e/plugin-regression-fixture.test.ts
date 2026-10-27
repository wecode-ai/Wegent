import { expect, test, vi } from 'vitest'
import { assertInstallButton } from '../../e2e/desktop/modules/plugin-regression-fixture.mjs'

test('checks the enabled install label before reconciliation can replace the button', async () => {
  const command = vi.fn(async (action: string) => {
    // A later command sees the disabled button excluded by the selector.
    return action === 'waitFor' ? '安装' : ''
  })
  await expect(assertInstallButton({ command }, { pluginId: 101 })).resolves.toBeUndefined()
})

test('rejects an enabled control that is not an install action', async () => {
  const command = vi.fn(async () => '正在安装')
  await expect(assertInstallButton({ command }, { pluginId: 101 })).rejects.toThrow()
})
