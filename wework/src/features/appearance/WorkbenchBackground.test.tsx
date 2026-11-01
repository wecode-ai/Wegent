import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AppearanceProvider } from './AppearanceProvider'
import { WorkbenchBackground } from './WorkbenchBackground'

const { readElectronLocalFile } = vi.hoisted(() => ({
  readElectronLocalFile: vi.fn(),
}))
const { isElectronRuntime } = vi.hoisted(() => ({ isElectronRuntime: vi.fn() }))

vi.mock('@/lib/electron-local-file', () => ({ readElectronLocalFile }))
vi.mock('@/lib/runtime-environment', () => ({ isElectronRuntime }))

const originalCreateObjectUrl = URL.createObjectURL
const originalRevokeObjectUrl = URL.revokeObjectURL

function renderBackground() {
  return render(
    <AppearanceProvider>
      <WorkbenchBackground />
    </AppearanceProvider>
  )
}

describe('WorkbenchBackground', () => {
  beforeEach(() => {
    localStorage.clear()
    readElectronLocalFile.mockReset()
    readElectronLocalFile.mockResolvedValue(new Uint8Array([1, 2, 3]))
    isElectronRuntime.mockReset()
    isElectronRuntime.mockReturnValue(true)
    URL.createObjectURL = vi.fn(() => 'blob:workbench-background')
    URL.revokeObjectURL = vi.fn()
  })

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectUrl
    URL.revokeObjectURL = originalRevokeObjectUrl
  })

  test('renders the configured image through a Blob URL', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({
        backgroundImagePath: '/app-data/background.png',
        backgroundVisibility: 100,
        backgroundBlur: 12,
      })
    )

    renderBackground()

    const image = await screen.findByTestId('workbench-background-image')
    expect(image).toHaveAttribute('src', 'blob:workbench-background')
    expect(image).toHaveAttribute('data-image-loaded', 'false')
    expect(readElectronLocalFile).toHaveBeenCalledWith('/app-data/background.png')

    fireEvent.load(image)

    expect(image).toHaveAttribute('data-image-loaded', 'true')
    expect(screen.getByTestId('workbench-background-overlay')).toHaveStyle({ opacity: 0 })
    expect(image).toHaveStyle({
      filter: 'blur(12px)',
    })
  })

  test('releases the Blob URL when the background unmounts', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )

    const view = renderBackground()
    await screen.findByTestId('workbench-background-image')

    view.unmount()

    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:workbench-background')
  })

  test('hides a background image that cannot be loaded', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/background.png' })
    )

    renderBackground()
    fireEvent.error(await screen.findByTestId('workbench-background-image'))

    await waitFor(() =>
      expect(screen.queryByTestId('workbench-background')).not.toBeInTheDocument()
    )
  })

  test('hides the background when the file bridge cannot read the image', async () => {
    localStorage.setItem(
      'wework.appearance',
      JSON.stringify({ backgroundImagePath: '/app-data/missing.png' })
    )
    readElectronLocalFile.mockRejectedValue(new Error('Local file path is not a regular file'))

    renderBackground()

    await waitFor(() =>
      expect(screen.queryByTestId('workbench-background')).not.toBeInTheDocument()
    )
  })
})
