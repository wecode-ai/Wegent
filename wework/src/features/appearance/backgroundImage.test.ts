import { beforeEach, describe, expect, test, vi } from 'vitest'
import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  backgroundImageUrl,
  removeWorkbenchBackground,
  selectWorkbenchBackground,
} from './backgroundImage'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  invoke: vi.fn(),
  isTauri: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }))

describe('workbench background image service', () => {
  beforeEach(() => {
    vi.mocked(isTauri).mockReturnValue(true)
    vi.mocked(open).mockReset()
    vi.mocked(invoke).mockReset()
  })

  test('imports the selected image through the managed Tauri command', async () => {
    vi.mocked(open).mockResolvedValue('/tmp/source.png')
    vi.mocked(invoke).mockResolvedValue('/app-data/background.png')

    await expect(selectWorkbenchBackground()).resolves.toBe('/app-data/background.png')
    expect(invoke).toHaveBeenCalledWith('import_workbench_background', {
      sourcePath: '/tmp/source.png',
    })
  })

  test('does not import when the picker is cancelled', async () => {
    vi.mocked(open).mockResolvedValue(null)

    await expect(selectWorkbenchBackground()).resolves.toBeNull()
    expect(invoke).not.toHaveBeenCalled()
  })

  test('removes managed images and converts their display URL', async () => {
    await removeWorkbenchBackground()

    expect(invoke).toHaveBeenCalledWith('remove_workbench_background')
    expect(backgroundImageUrl('/app-data/background.webp')).toBe(
      'asset://localhost//app-data/background.webp'
    )
    expect(convertFileSrc).toHaveBeenCalledWith('/app-data/background.webp')
  })
})
