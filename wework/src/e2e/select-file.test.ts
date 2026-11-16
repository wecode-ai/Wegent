import { afterEach, expect, it, vi } from 'vitest'
import { selectDesktopControlFile } from './select-file'

afterEach(() => vi.unstubAllGlobals())

it('selects fixture bytes and dispatches the real file-input change event', () => {
  const files: File[] = []
  vi.stubGlobal(
    'DataTransfer',
    class {
      files = files
      items = { add: (file: File) => files.push(file) }
    }
  )
  const input = document.createElement('input')
  input.type = 'file'
  const setFiles = vi.fn()
  Object.defineProperty(input, 'files', { set: setFiles })
  const changed = vi.fn()
  input.addEventListener('change', changed)
  expect(
    selectDesktopControlFile(input, {
      action: 'selectFile',
      filename: 'workflow.yaml',
      value: 'YQ==',
    })
  ).toBe('workflow.yaml')
  expect(setFiles).toHaveBeenCalledWith(files)
  expect(files[0].name).toBe('workflow.yaml')
  expect(files[0].size).toBe(1)
  expect(changed).toHaveBeenCalledOnce()
})

it('rejects non-file controls', () => {
  expect(() =>
    selectDesktopControlFile(document.createElement('input'), { action: 'selectFile' })
  ).toThrow('selectFile requires a file input')
})
