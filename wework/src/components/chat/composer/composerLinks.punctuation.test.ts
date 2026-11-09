// @vitest-environment node

import { expect, test } from 'vitest'
import { extractFirstLink } from '@/lib/link-preview'
import { parseComposerLinks } from './composerLinks'
import { createComposerDocument, serializeComposerDocument } from './composerProseMirrorModel'

test('keeps Chinese instructions outside a pasted repository link', () => {
  const url = 'https://github.com/wecode-ai/Wegent/pull/4335'
  const instructions = '：只读，不修改代码；有变化告诉我。'
  const value = `跟进（${url}）${instructions}`
  const links = parseComposerLinks(value)

  expect(links).toHaveLength(1)
  expect(links[0].url).toBe(url)
  expect(value.slice(links[0].end)).toBe(`）${instructions}`)
  expect(extractFirstLink(value)?.url).toBe(url)
  const serialized = serializeComposerDocument(createComposerDocument(value))
  expect(serialized).toContain(`](${url})）${instructions}`)
  expect(serialized).not.toContain('%EF%BC')
  expect(serializeComposerDocument(createComposerDocument(serialized))).toBe(serialized)
})

test('preserves Chinese URL paths and explicitly linked punctuation', () => {
  const url = 'https://github.com/team/中文仓库/issues/12?label=已确认'
  expect(parseComposerLinks(`查看「${url}」，再继续。`)[0]?.url).toBe(url)
  const explicit = '[说明](https://github.com/team/repo/blob/main/说明（最终版）.md)'
  expect(parseComposerLinks(explicit)[0]?.url).toBe(
    'https://github.com/team/repo/blob/main/说明（最终版）.md'
  )
})
