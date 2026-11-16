import { describe, expect, it } from 'vitest'
import type { Attachment, TurnFileChangesSummary } from '../../../packages/chat-core/src/runtime'
import type { MobileFileRequest } from '@/types/files'
import { mobileFileKey, mobileFileName, resolveMobileFileLink } from './mobileFiles'

const target = {
  deviceId: 'device-a',
  path: '/repo/worktree',
  taskId: 'task-a',
  workspaceSource: 'worktree',
}

const summary: TurnFileChangesSummary = {
  version: 1,
  status: 'active',
  device_id: 'device-a',
  workspace_path: '/repo/worktree',
  artifact_id: 'turn-file-changes/turn-1',
  file_count: 1,
  additions: 1,
  deletions: 0,
  files: [{ path: 'src/a.ts', change_type: 'created', additions: 1, deletions: 0, binary: false }],
}

function attachment(
  overrides: Partial<Attachment> = {}
): Extract<MobileFileRequest, { kind: 'attachment' }> {
  return {
    kind: 'attachment',
    attachment: {
      id: 7,
      filename: 'a.ts',
      file_size: 10,
      mime_type: 'text/plain',
      status: 'ready',
      file_extension: 'ts',
      created_at: '2026-11-14',
      ...overrides,
    },
  }
}

describe('mobile file identity', () => {
  it('keeps device identity in workspace keys while reusing file content across line navigation', () => {
    const request = {
      kind: 'workspace',
      target,
      path: '/repo/worktree/a.ts',
      lineStart: 1,
    } as const
    expect(mobileFileKey(request)).toBe(mobileFileKey({ ...request, lineStart: 12, lineEnd: 15 }))
    expect(mobileFileKey(request)).not.toBe(
      mobileFileKey({ ...request, target: { ...target, deviceId: 'device-b' } })
    )
  })

  it('uses workspace attachment identity instead of its numeric attachment ID', () => {
    const reference = {
      device_id: 'original-device',
      workspace_path: '/original/worktree',
      path: 'a.ts',
    }
    const first = attachment({ id: 1, workspace_file: reference })
    const second = attachment({ id: 2, workspace_file: reference })
    expect(mobileFileKey(first)).toBe(mobileFileKey(second))
    expect(mobileFileKey(first)).not.toBe(mobileFileKey(attachment({ id: 1 })))
    expect(mobileFileKey(first)).not.toBe(
      mobileFileKey(
        attachment({ id: 1, workspace_file: { ...reference, workspace_path: '/other/worktree' } })
      )
    )
    expect(mobileFileKey(first)).not.toBe(
      mobileFileKey(
        attachment({ id: 1, workspace_file: { ...reference, device_id: 'other-device' } })
      )
    )
  })

  it('keeps diff artifact caches separate across original workspaces and devices', () => {
    const request = { kind: 'diff', summary, path: 'src/a.ts' } as const
    expect(mobileFileKey(request)).not.toBe(
      mobileFileKey({ ...request, summary: { ...summary, workspace_path: '/other/worktree' } })
    )
    expect(mobileFileKey(request)).not.toBe(
      mobileFileKey({ ...request, summary: { ...summary, device_id: 'device-b' } })
    )
    expect(mobileFileKey(request)).not.toBe(mobileFileKey({ ...request, path: 'src/b.ts' }))
  })

  it('separates native phone files, embedded images, and remote attachment identities', () => {
    const local = {
      kind: 'local',
      uri: 'file:///phone/a.png',
      name: 'a.png',
      mimeType: 'image/png',
    } as const
    const image = { kind: 'image', dataUri: 'data:image/png;base64,YWJj', name: 'a.png' } as const
    expect(
      new Set([mobileFileKey(local), mobileFileKey(image), mobileFileKey(attachment())]).size
    ).toBe(3)
    expect(mobileFileKey(image)).not.toBe(
      mobileFileKey({ ...image, dataUri: 'data:image/png;base64,YWJk' })
    )
    expect(mobileFileName(image)).toBe('a.png')
    expect(mobileFileName(local)).toBe('a.png')
    expect(mobileFileName({ kind: 'diff', summary })).toBe('文件变更.diff')
  })
})

describe('resolveMobileFileLink PC contract parity', () => {
  it('resolves encoded relative links and line ranges against the owning workspace', () => {
    expect(resolveMobileFileLink('src%2Fhello%20world.ts:12-18', target)).toEqual({
      kind: 'file',
      request: {
        kind: 'workspace',
        target,
        path: '/repo/worktree/src/hello world.ts',
        lineStart: 12,
        lineEnd: 18,
      },
    })
  })

  it('preserves absolute files outside the task workspace as PC cloud devices do', () => {
    expect(resolveMobileFileLink('/other/project/file.ts:9', target)).toMatchObject({
      kind: 'file',
      request: { target, path: '/other/project/file.ts', lineStart: 9 },
    })
    expect(resolveMobileFileLink('file:///other/project/file.ts:9', target)).toMatchObject({
      kind: 'file',
      request: { target, path: '/other/project/file.ts', lineStart: 9 },
    })
  })

  it('resolves Windows links with the shared PC path contract', () => {
    const windowsTarget = { ...target, path: 'C:/repo/worktree' }
    expect(resolveMobileFileLink('C:\\Other\\file.ts:8', windowsTarget)).toMatchObject({
      kind: 'file',
      request: { target: windowsTarget, path: 'C:/Other/file.ts', lineStart: 8 },
    })
    expect(resolveMobileFileLink('src\\file.ts', windowsTarget)).toMatchObject({
      kind: 'file',
      request: { path: 'C:/repo/worktree/src/file.ts' },
    })
  })

  it('opens directory links while preserving device and workspace metadata', () => {
    expect(resolveMobileFileLink('folder:///other/project', target)).toEqual({
      kind: 'directory',
      target: { ...target, path: '/other/project' },
    })
  })

  it.each(['https://example.com/docs', 'mailto:user@example.com', 'tel:123'])(
    'keeps external link %s external without requiring a workspace',
    href => {
      expect(resolveMobileFileLink(href, null)).toEqual({ kind: 'external', url: href })
    }
  )

  it.each([
    'javascript:alert(1)',
    'data:text/html;base64,YWJj',
    'vbscript:msgbox(1)',
    'javascript%3Aalert(1)',
    '#heading',
  ])('does not route unsafe or anchor link %s to a file', href => {
    expect(resolveMobileFileLink(href, target)).toEqual({ kind: 'none' })
  })

  it('fails clearly when a file has no owning workspace or cannot be resolved by PC rules', () => {
    expect(() => resolveMobileFileLink('src/a.ts', null)).toThrow('当前会话尚无可访问的文件目录')
    expect(() => resolveMobileFileLink('../a.ts', target)).toThrow('文件路径无效')
  })
})
