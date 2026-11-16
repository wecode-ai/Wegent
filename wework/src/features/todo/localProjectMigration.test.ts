import { Blob } from 'node:buffer'
import { webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, CollaborationProject } from '@wegent/collaboration'
import type { HttpClient } from '@/api/http'
import type { ProjectChatClient } from '@/api/backend/projectChatSocket'
import { migrateLocalProject } from './localProjectMigration'

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', webcrypto)
})
afterEach(() => vi.unstubAllGlobals())
function fixture() {
  const project = {
    id: 'local-p',
    name: 'Private local work',
    description: 'Project',
    version: 1,
    project_store: 'local',
    default_issue_security: 'related',
  } as CollaborationProject
  const sourceApi = {
    projects: { get: vi.fn().mockResolvedValue(project), archive: vi.fn() },
    issues: {
      list: vi.fn().mockResolvedValue([
        {
          id: 'issue',
          parent_id: null,
          title: 'Task',
          description: '![file](wegent://attachments/file)',
          status: 'inbox',
          priority: 'high',
          assignee_user_id: 0,
          security_level: 'related',
          version: 1,
          created_at: '2026-11-13T06:00:00Z',
          updated_at: '2026-11-13T06:00:00Z',
          runtime_task_id: 'PRIVATE_SESSION',
        },
      ]),
      listArchived: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    },
    attachments: {
      list: vi
        .fn()
        .mockResolvedValue([{ id: 'file', display_name: 'notes.txt', content_type: 'text/plain' }]),
      read: vi.fn().mockResolvedValue(new Blob(['attachment bytes'])),
    },
  } as unknown as SharedWorkspaceApi
  const chat = {
    subscribe: vi.fn().mockResolvedValue({
      snapshot: {
        messages: [
          {
            messageId: 'comment',
            sender: { name: 'Owner' },
            type: 'text',
            content: 'Public comment',
            status: 'completed',
            createdAt: '2026-11-13T06:00:00Z',
            updatedAt: '2026-11-13T06:00:00Z',
            metadata: { runtime_task_id: 'PRIVATE_SESSION' },
          },
        ],
      },
      unsubscribe: vi.fn(),
    }),
  } as unknown as ProjectChatClient
  let target: CollaborationProject | undefined
  const targetApi = {
    projects: {
      list: vi.fn(async () => (target ? [target] : [])),
      create: vi.fn(async (input: { projectKey: string }) => {
        target = {
          id: 'cloud-p',
          project_key: input.projectKey,
          version: 2,
        } as CollaborationProject
        return target
      }),
      get: vi.fn(async () => target),
      archive: vi.fn(),
    },
  } as unknown as SharedWorkspaceApi
  const http = {
    post: vi.fn().mockResolvedValue({ sha256: 'digest' }),
    get: vi.fn().mockResolvedValue({ source: 'source', sha256: 'digest' }),
  } as unknown as HttpClient
  const sourceGuard = {
    read: vi.fn().mockResolvedValue({
      version: 1,
      fingerprint: 'snapshot',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    }),
    archive: vi.fn().mockResolvedValue(undefined),
  }
  return { project, sourceApi, targetApi, chat, http, sourceGuard, source: 'source', userId: 7 }
}

it('moves only shared data, preserves privacy and archives through the atomic source guard', async () => {
  const input = fixture()
  await migrateLocalProject(input)
  const body = vi.mocked(input.http.post).mock.calls[0][1] as {
    issues: Array<{ security_level: string }>
    attachments: unknown[]
  }
  expect(body.issues[0].security_level).toBe('related')
  expect(body.attachments).toHaveLength(1)
  expect(JSON.stringify(body)).not.toContain('PRIVATE_SESSION')
  expect(input.sourceGuard.archive).toHaveBeenCalledWith(1, 'snapshot', 'cloud-p')
  expect(input.sourceApi.projects.archive).not.toHaveBeenCalled()
})
it('keeps the source intact after upload failure and reuses the same target on retry', async () => {
  const input = fixture()
  vi.mocked(input.http.post).mockRejectedValueOnce(new Error('Connection lost'))
  await expect(migrateLocalProject(input)).rejects.toThrow('Connection lost')
  expect(input.sourceGuard.archive).not.toHaveBeenCalled()
  await migrateLocalProject(input)
  expect(input.targetApi.projects.create).toHaveBeenCalledOnce()
})
it('rolls back the staged cloud copy when a source write races with finalization', async () => {
  const input = fixture()
  input.sourceGuard.archive.mockRejectedValue(new Error('Version conflict'))
  input.sourceGuard.read
    .mockResolvedValueOnce({
      version: 1,
      fingerprint: 'snapshot',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    })
    .mockResolvedValueOnce({
      version: 1,
      fingerprint: 'snapshot',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    })
    .mockResolvedValue({
      version: 2,
      fingerprint: 'changed',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    })
  await expect(migrateLocalProject(input)).rejects.toThrow('local_project_changed_during_migration')
  expect(input.targetApi.projects.archive).toHaveBeenCalledWith('cloud-p', 2)
  expect(input.sourceApi.projects.archive).not.toHaveBeenCalled()
})
it('resolves a committed source archive with a lost response without reading or deleting private sessions', async () => {
  const input = fixture()
  input.sourceGuard.archive.mockRejectedValue(new Error('Response lost'))
  input.sourceGuard.read
    .mockResolvedValueOnce({
      version: 1,
      fingerprint: 'snapshot',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    })
    .mockResolvedValueOnce({
      version: 1,
      fingerprint: 'snapshot',
      archived: false,
      migration_target: null,
      migration_fingerprint: null,
    })
    .mockResolvedValue({
      version: 2,
      fingerprint: 'archived',
      archived: true,
      migration_target: 'cloud-p',
      migration_fingerprint: 'snapshot',
    } as never)
  await expect(migrateLocalProject(input)).resolves.toMatchObject({ id: 'cloud-p' })
  expect(input.targetApi.projects.archive).not.toHaveBeenCalled()
})

it('does not post a changed source into a completed import after a final read failure', async () => {
  const input = fixture()
  vi.mocked(input.targetApi.projects.get).mockRejectedValueOnce(new Error('Read unavailable'))
  await expect(migrateLocalProject(input)).rejects.toThrow('Read unavailable')
  input.sourceGuard.read.mockResolvedValue({
    version: 2,
    fingerprint: 'changed',
    archived: false,
    migration_target: null,
    migration_fingerprint: null,
  })
  await expect(migrateLocalProject(input)).rejects.toThrow('local_project_changed_during_migration')
  expect(input.http.post).toHaveBeenCalledOnce()
  expect(input.sourceGuard.archive).not.toHaveBeenCalled()
})
