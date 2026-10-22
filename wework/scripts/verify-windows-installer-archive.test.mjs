import { describe, expect, test } from 'vitest'

import { arm64FilteredEntries } from './verify-windows-installer-archive.mjs'

const listing = [
  '7-Zip (a) [64] 25.01 : Copyright (c) 1999-2025 Igor Pavlov : 2025-08-03',
  '',
  'Listing archive: app-arm64.7z',
  '',
  '--',
  'Path = app-arm64.7z',
  'Type = 7z',
  'Method = 0A LZMA2:20 LZMA2:20 BCJ2',
  'Physical Size = 396523376',
  '',
  '----------',
  'Path = resources',
  'Size = 0',
  'Method = ',
  '',
  'Path = WeWork.exe',
  'Size = 226791936',
  'Method = 0A LZMA2:20',
  '',
  'Path = icudtl.dat',
  'Size = 10875024',
  'Method = LZMA2:20',
  '',
  'Path = resources/bin/wegent-executor.exe',
  'Size = 12615168',
  'Method = 0A LZMA2:20',
  '',
].join('\n')

describe('arm64FilteredEntries', () => {
  test('reports entries packed with the ARM64 BCJ filter', () => {
    expect(arm64FilteredEntries(listing)).toEqual([
      'WeWork.exe',
      'resources/bin/wegent-executor.exe',
    ])
  })

  test('accepts listings that use the x86 BCJ filter', () => {
    const bcjListing = listing.replaceAll('Method = 0A', 'Method = BCJ')
    expect(arm64FilteredEntries(bcjListing)).toEqual([])
  })

  test('handles Windows line endings and ignores the archive summary method', () => {
    const windowsListing = [
      'Path = app-arm64.7z',
      'Method = 0A LZMA2:20',
      '----------',
      'Path = libEGL.dll',
      'Method = BCJ LZMA2:20',
      '',
    ].join('\r\n')
    expect(arm64FilteredEntries(windowsListing)).toEqual([])
  })
})
