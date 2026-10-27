// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TagEditor } from './TagEditor'

let container: HTMLDivElement
let root: Root
const onChange = vi.fn()

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  onChange.mockReset()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

async function type(value: string) {
  const input = container.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  await act(async () => input.dispatchEvent(new Event('input', { bubbles: true })))
  return input
}

it.each(['a', '标', '😀'])('preserves 32 code points and rejects 33: %s', async character => {
  await act(async () =>
    root.render(
      <TagEditor tags={[]} onChange={onChange} testIdPrefix="tags" lengthErrorLabel="Too long" />
    )
  )
  const tag = character.repeat(32)
  const input = await type(`${tag}${character},`)
  expect(onChange).not.toHaveBeenCalled()
  expect(input.value).toBe(tag + character)
  expect(input.getAttribute('aria-invalid')).toBe('true')
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Too long')
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(onChange).not.toHaveBeenCalled()
  await type(tag)
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  )
  expect(onChange).toHaveBeenCalledExactlyOnceWith([tag])
  expect(input.value).toBe('')
})
