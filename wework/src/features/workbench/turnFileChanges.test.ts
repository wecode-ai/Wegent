import { describe, expect, test } from 'vitest'
import { mergeTurnFileChanges, normalizeTurnFileChanges } from './turnFileChanges'

const summary = {
  version: 1 as const,
  status: 'active' as const,
  artifact_id: 'turn-8-21',
  device_id: 'device-1',
  workspace_path: '/workspace/project',
  file_count: 1,
  additions: 4,
  deletions: 2,
  files: [
    {
      path: 'src/main.ts',
      change_type: 'modified' as const,
      additions: 4,
      deletions: 2,
      binary: false,
    },
  ],
}

describe('normalizeTurnFileChanges', () => {
  test('normalizes a valid per-turn summary', () => {
    expect(normalizeTurnFileChanges(summary)).toEqual(summary)
  })

  test('keeps runtime inline diff metadata', () => {
    expect(
      normalizeTurnFileChanges({
        ...summary,
        diff: 'diff --git a/src/main.ts b/src/main.ts',
        revertible: false,
      })
    ).toEqual({
      ...summary,
      diff: 'diff --git a/src/main.ts b/src/main.ts',
      revertible: false,
    })
  })

  test('rejects malformed files and inconsistent file counts', () => {
    expect(
      normalizeTurnFileChanges({
        ...summary,
        file_count: 2,
      })
    ).toBeUndefined()
    expect(
      normalizeTurnFileChanges({
        ...summary,
        files: [{ ...summary.files[0], additions: -1 }],
      })
    ).toBeUndefined()
  })
})

describe('mergeTurnFileChanges', () => {
  test('combines file change blocks into one turn summary', () => {
    const second = {
      ...summary,
      artifact_id: 'artifact-2',
      file_count: 1,
      additions: 2,
      deletions: 0,
      files: [
        {
          path: 'src/second.ts',
          change_type: 'created' as const,
          additions: 2,
          deletions: 0,
          binary: false,
        },
      ],
    }

    expect(mergeTurnFileChanges([summary, second])).toMatchObject({
      artifact_id: summary.artifact_id,
      file_count: 2,
      additions: 6,
      deletions: 2,
      files: [summary.files[0], second.files[0]],
    })
  })

  test('preserves a rename when the renamed file is modified later', () => {
    const renamed = {
      ...summary,
      files: [
        {
          ...summary.files[0],
          old_path: 'src/old.ts',
          path: 'src/new.ts',
          change_type: 'renamed' as const,
        },
      ],
    }
    const modified = {
      ...summary,
      additions: 2,
      deletions: 1,
      files: [
        {
          ...summary.files[0],
          path: 'src/new.ts',
          change_type: 'modified' as const,
          additions: 2,
          deletions: 1,
        },
      ],
    }

    expect(mergeTurnFileChanges([renamed, modified])?.files).toEqual([
      expect.objectContaining({
        old_path: 'src/old.ts',
        path: 'src/new.ts',
        change_type: 'renamed',
        additions: 6,
        deletions: 3,
      }),
    ])
  })
})
