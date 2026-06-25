import { describe, expect, test } from 'vitest'
import { normalizeTurnFileChanges } from './turnFileChanges'

const summary = {
  version: 1,
  status: 'active',
  artifact_id: 'turn-8-21',
  device_id: 'device-1',
  workspace_path: '/workspace/project',
  file_count: 1,
  additions: 4,
  deletions: 2,
  files: [
    {
      path: 'src/main.ts',
      change_type: 'modified',
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
