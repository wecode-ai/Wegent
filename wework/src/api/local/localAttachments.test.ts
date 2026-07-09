import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createLocalAttachmentApi } from './localAttachments'

const tauriMocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriMocks.invoke,
}))

vi.mock('@/lib/runtime-environment', () => ({
  isTauriRuntime: () => true,
}))

describe('local attachment API', () => {
  beforeEach(() => {
    tauriMocks.invoke.mockReset()
  })

  test('stores uploaded files under executor home instead of the active project workspace', async () => {
    tauriMocks.invoke.mockResolvedValue(
      '/Users/me/.wegent-executor/workspace/attachments/draft/123/photo.png'
    )
    const file = new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' })
    const progress = vi.fn()

    const api = createLocalAttachmentApi()
    const uploadWithLegacyContext = api.uploadAttachment as (
      file: File,
      onProgress?: (progress: number) => void,
      context?: { workspacePath?: string | null }
    ) => Promise<Awaited<ReturnType<typeof api.uploadAttachment>>>

    const attachment = await uploadWithLegacyContext(file, progress, {
      workspacePath: '/Users/me/project',
    })

    expect(tauriMocks.invoke).toHaveBeenCalledWith('save_local_attachment_file', {
      workspacePath: null,
      filename: 'photo.png',
      bytes: [1, 2, 3],
    })
    expect(progress).toHaveBeenNthCalledWith(1, 0)
    expect(progress).toHaveBeenNthCalledWith(2, 100)
    expect(attachment.local_path).toBe(
      '/Users/me/.wegent-executor/workspace/attachments/draft/123/photo.png'
    )
  })
})
