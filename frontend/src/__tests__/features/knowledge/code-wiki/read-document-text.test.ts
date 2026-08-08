// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * The reader asked for `limit: 1` and rendered the single character it got back.
 * `limit` is a character count, not a page number, and the call looked correct at
 * every level — which is why nothing caught it until a wiki was opened.
 */

import { readDocumentText, getDocumentContent } from '@/apis/knowledge'

const get = jest.fn()
jest.mock('@/apis/client', () => {
  const stub = { get: (...args: unknown[]) => get(...args) }
  return { __esModule: true, apiClient: stub, default: stub }
})

const chunk = (content: string, hasMore: boolean, offset = 0) => ({
  document_id: 1,
  name: 'page',
  content,
  total_length: 0,
  offset,
  returned_length: content.length,
  has_more: hasMore,
  kb_id: 1,
  index_status: 'success',
})

describe('reading a document in full', () => {
  beforeEach(() => jest.clearAllMocks())

  it('asks for the body, not one character of it', async () => {
    get.mockResolvedValueOnce(chunk('# Title\n\nBody.', false))

    await readDocumentText(7)

    const url = get.mock.calls[0][0] as string
    expect(url).toContain('limit=100000')
    expect(url).not.toContain('limit=1&')
  })

  it('follows the pagination rather than truncating at the cap', async () => {
    get
      .mockResolvedValueOnce(chunk('first ', true))
      .mockResolvedValueOnce(chunk('second', false, 6))

    expect(await readDocumentText(7)).toBe('first second')
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('advances by what the server says it returned', async () => {
    get.mockResolvedValueOnce(chunk('abcde', true)).mockResolvedValueOnce(chunk('fgh', false, 5))

    await readDocumentText(7)

    expect(get.mock.calls[1][0]).toContain('offset=5')
  })

  it('stops on a document that claims more but sends none', async () => {
    // Otherwise a server bug becomes a hung tab rather than a short page.
    get.mockResolvedValue(chunk('', true))

    expect(await readDocumentText(7)).toBe('')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('still offers the cheap identity read the lookup path uses', async () => {
    // getDocumentContent keeps its limit of 1 on purpose: one caller wants only the
    // kb_id and name. The fix is a second operation, not a changed default.
    get.mockResolvedValueOnce(chunk('a', true))

    await getDocumentContent(7)

    expect(get.mock.calls[0][0]).toContain('limit=1')
  })
})
