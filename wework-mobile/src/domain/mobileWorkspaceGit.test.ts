import { describe, expect, it } from 'vitest'
import { mobileWorkspaceChangedFiles } from './mobileWorkspaceGit'

describe('mobileWorkspaceChangedFiles PC review parity', () => {
  it('preserves rename paths, binary changes, empty additions and deleted files', () => {
    const diff = [
      'diff --git a/old name.txt b/new name.txt',
      'similarity index 100%',
      'rename from old name.txt',
      'rename to new name.txt',
      'diff --git a/image.png b/image.png',
      'GIT binary patch',
      'literal 3',
      'Abc',
      'diff --git a/empty.txt b/empty.txt',
      'new file mode 100644',
      'diff --git a/deleted.txt b/deleted.txt',
      'deleted file mode 100644',
      '--- a/deleted.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-removed',
    ].join('\n')
    expect(mobileWorkspaceChangedFiles(diff)).toMatchObject([
      {
        path: 'new name.txt',
        oldPath: 'old name.txt',
        status: 'renamed',
        additions: 0,
        deletions: 0,
      },
      { path: 'image.png', status: 'modified', additions: 0, deletions: 0 },
      { path: 'empty.txt', oldPath: undefined, status: 'added', additions: 0, deletions: 0 },
      { path: 'deleted.txt', status: 'deleted', additions: 0, deletions: 1 },
    ])
  })

  it('decodes Git octal UTF-8 paths with the PC parser and merges repeated sections', () => {
    const header = 'diff --git "a/\\344\\270\\255.txt" "b/\\344\\270\\255.txt"'
    const diff = `${header}\n@@ -1 +1 @@\n-before\n+after\n${header}\n@@ -3 +3 @@\n-old\n+new`
    expect(mobileWorkspaceChangedFiles(diff)).toMatchObject([
      { path: '中.txt', additions: 2, deletions: 2, status: 'modified' },
    ])
  })
})
