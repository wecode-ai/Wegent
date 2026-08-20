import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { readFileFromAccessUrl, saveBlobToDownloads } from './cloudFileTransfer'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@/lib/runtime-environment', () => ({ isTauriRuntime: vi.fn() }))

describe('cloudFileTransfer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isTauriRuntime).mockReturnValue(true)
  })

  it('reads remote object storage files through the Tauri HTTP client', async () => {
    const blob = new Blob(['snapshot'])
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: true,
      status: 200,
      blob: vi.fn(async () => blob),
    } as unknown as Response)

    await expect(readFileFromAccessUrl('https://objects.example/snapshot.md')).resolves.toEqual(
      blob
    )
    expect(tauriFetch).toHaveBeenCalledWith('https://objects.example/snapshot.md')
  })

  it('writes downloaded bytes to the native Downloads directory', async () => {
    vi.mocked(invoke).mockResolvedValue('/Downloads/snapshot.md')

    await expect(saveBlobToDownloads(new Blob(['snapshot']), 'snapshot.md')).resolves.toBe(
      '/Downloads/snapshot.md'
    )
    expect(invoke).toHaveBeenCalledWith('save_binary_file_to_downloads', {
      filename: 'snapshot.md',
      bytes: Array.from(new TextEncoder().encode('snapshot')),
    })
  })
})
