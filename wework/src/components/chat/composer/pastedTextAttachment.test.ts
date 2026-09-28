import { describe, expect, test } from 'vitest'
import { createLongPastedTextAttachment, isPastedTextFile } from '@wegent/collaboration/composer'

describe('pasted text attachments', () => {
  test.each([1, 100, 4000, 4001, 4999])('keeps %i characters of multiline text inline', length => {
    const text = 'test\n'.repeat(Math.ceil(length / 5)).slice(0, length)
    expect(createLongPastedTextAttachment(text)).toBeNull()
  })

  test.each([5000, 5001])('attaches %i characters without changing their content', async length => {
    const text = 'test\n'.repeat(Math.ceil(length / 5)).slice(0, length)
    const file = createLongPastedTextAttachment(text)!
    expect(await file.text()).toBe(text)
    expect(isPastedTextFile(file)).toBe(true)
    expect(isPastedTextFile(new File([text], file.name))).toBe(false)
  })
})
