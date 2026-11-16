import { describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue } from '../types'
import { prepareIssueArchiveSubtree } from './prepareIssueArchive'

const issue = (id: string, parent_id: string | null, can_view_detail = true) =>
  ({ id, parent_id, can_view_detail }) as CollaborationIssue

describe('archive subtree execution preparation', () => {
  it('prepares readable descendants without requesting restricted bindings', async () => {
    const root = issue('root', null)
    const hidden = issue('private', root.id, false)
    const child = issue('child', hidden.id)
    const unrelated = issue('other', null)
    const prepare = vi.fn(async (target) => {
      if (target.can_view_detail === false)
        throw new Error('404: private Issue')
    })

    await prepareIssueArchiveSubtree(
      [root, hidden, child, unrelated],
      root,
      prepare,
    )

    expect(prepare.mock.calls.map(([target]) => target.id)).toEqual([
      'root',
      'child',
    ])
  })
  it('rejects preparation if a readable descendant cannot be stopped', async () => {
    const root = issue('root', null)
    const child = issue('child', root.id)
    const later = issue('later', root.id)
    const prepare = vi.fn(async (target) => {
      if (target.id === child.id)
        throw new Error('Stop acknowledgement missing')
    })

    await expect(
      prepareIssueArchiveSubtree([root, child, later], root, prepare),
    ).rejects.toThrow('Stop acknowledgement missing')
    expect(prepare.mock.calls.map(([target]) => target.id)).toEqual([
      'root',
      'child',
    ])
  })
  it('prepares the selected root even when the snapshot has not loaded it', async () => {
    const prepare = vi.fn().mockResolvedValue(undefined)
    const root = issue('root', null)
    await prepareIssueArchiveSubtree([], root, prepare)
    expect(prepare).toHaveBeenCalledExactlyOnceWith(root)
  })
})
