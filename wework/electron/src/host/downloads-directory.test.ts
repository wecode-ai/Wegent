import { describe, expect, test, vi } from 'vitest'

import { resolveDownloadsDirectory } from './downloads-directory.js'

describe('resolveDownloadsDirectory', () => {
  test('uses the system Downloads known folder when Electron resolves it', () => {
    const getPath = vi.fn((name: 'downloads' | 'home') => {
      if (name === 'downloads') return '/Users/test/System Downloads'
      return '/Users/test'
    })

    expect(resolveDownloadsDirectory(getPath)).toBe('/Users/test/System Downloads')
    expect(getPath).toHaveBeenCalledOnce()
  })

  test('uses Downloads under home when the Windows known folder is unavailable', () => {
    const knownFolderError = new Error("Failed to get 'downloads' path")
    const getPath = vi.fn((name: 'downloads' | 'home') => {
      if (name === 'downloads') throw knownFolderError
      return '/Users/test'
    })
    const onKnownFolderFailure = vi.fn()

    expect(resolveDownloadsDirectory(getPath, onKnownFolderFailure)).toBe('/Users/test/Downloads')
    expect(onKnownFolderFailure).toHaveBeenCalledWith(knownFolderError, '/Users/test/Downloads')
  })
})
