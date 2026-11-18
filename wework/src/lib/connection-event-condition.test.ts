import { describe, expect, test } from 'vitest'
import { connectionEventCondition } from './connection-event-condition'
const t = (_key: string, fallback: string) => fallback

describe('event conditions', () => {
  test('shows alternatives and preserves their common scope', () => {
    expect(
      connectionEventCondition(
        {
          '/sha': 'head',
          $any: [
            { '/external/payload/statusCheckRollup/state': 'SUCCESS' },
            { '/external/payload/statusCheckRollup/state': 'FAILURE' },
          ],
        },
        t
      )
    ).toBe('(检查结果: 通过 或 检查结果: 失败) 且 提交: head')
  })
  test('keeps object equality and resource identities literal', () => {
    expect(connectionEventCondition({ '/topicId': 'SUCCESS', '/revision': { n: 7 } }, t)).toBe(
      '目标: SUCCESS 且 revision: {"n":7}'
    )
  })
  test('distinguishes missing metadata from an unfiltered wait', () => {
    expect(connectionEventCondition(undefined, t)).toBe('未提供等待条件')
    expect(connectionEventCondition(null, t)).toBe('来源中的任意新事件')
    expect(connectionEventCondition({}, t)).toBe('来源中的任意新事件')
  })
})

test('describes merge conflict wake conditions while preserving literal identities', () => {
  expect(
    connectionEventCondition(
      {
        '/external/payload/headRefOid': 'CONFLICTING',
        $any: [
          { '/external/payload/mergeable': 'CONFLICTING' },
          { '/external/payload/mergeStateStatus': 'DIRTY' },
        ],
      },
      t
    )
  ).toBe('(合并状态: 存在冲突 或 合并门禁: 存在冲突) 且 提交: CONFLICTING')
})
