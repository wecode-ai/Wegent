import { expect, it } from 'vitest'
import { readHarnessToolResultOrder } from '../../e2e/desktop/modules/harness-tool-result-order.mjs'

const ids = ['call_00', 'call_01', 'call_02']
const rawOrder = String.raw`2026-11-11 14:53:04 harness protocol input tool results tool_result_order="[\"call_02\",\"call_00\",\"call_01\"]"`

it('reads the original receipt order without imposing a command scheduling order', () => {
  expect(readHarnessToolResultOrder(rawOrder, ids)).toEqual(['call_02', 'call_00', 'call_01'])
})

it('ignores incomplete or unrelated result groups', () => {
  const incomplete = String.raw`harness protocol input tool results tool_result_order="[\"call_00\"]"`
  expect(readHarnessToolResultOrder(incomplete, ids)).toBeNull()
  expect(readHarnessToolResultOrder(rawOrder, ['different'])).toBeNull()
})

it('rejects duplicate receipts instead of accepting a partial group', () => {
  const duplicate = String.raw`harness protocol input tool results tool_result_order="[\"call_00\",\"call_00\",\"call_02\"]"`
  expect(readHarnessToolResultOrder(duplicate, ids)).toBeNull()
})

it('does not hide a malformed diagnostic record', () => {
  expect(() =>
    readHarnessToolResultOrder('harness protocol input tool results tool_result_order=broken', ids)
  ).toThrow()
})
