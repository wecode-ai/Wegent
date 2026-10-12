// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  getPublicModelAllowedUsersFromConfig,
  getPublicModelAllowedUsersEnabledFromConfig,
  parseAllowedUsersInput,
  setPublicModelAllowedUsersEnabledInConfig,
  setPublicModelAllowedUsersInConfig,
} from '@/features/admin/components/PublicModelList'

describe('PublicModelList user whitelist config synchronization', () => {
  test('reads spec.allowedUsers from valid JSON', () => {
    expect(
      getPublicModelAllowedUsersFromConfig(
        JSON.stringify({
          kind: 'Model',
          spec: { allowedUsers: ['alice', 'bob', 7, '  '] },
        })
      )
    ).toEqual(['alice', 'bob'])
  })

  test('returns empty list when no whitelist is configured', () => {
    expect(
      getPublicModelAllowedUsersFromConfig(JSON.stringify({ kind: 'Model', spec: {} }))
    ).toEqual([])
    expect(getPublicModelAllowedUsersFromConfig('{"spec":')).toEqual([])
  })

  test('parses comma and whitespace separated usernames with dedupe', () => {
    expect(parseAllowedUsersInput('alice, bob\nalice  ,carol')).toEqual(['alice', 'bob', 'carol'])
    expect(parseAllowedUsersInput('')).toEqual([])
  })

  test('parses full-width and half-width commas as separators', () => {
    expect(parseAllowedUsersInput('alice，bob，carol')).toEqual(['alice', 'bob', 'carol'])
    expect(parseAllowedUsersInput('alice， bob, carol')).toEqual(['alice', 'bob', 'carol'])
  })

  test('writes the whitelist into spec.allowedUsers and clears it when empty', () => {
    const updated = setPublicModelAllowedUsersInConfig(
      JSON.stringify({ kind: 'Model', spec: { modelType: 'llm' } }),
      ['alice', 'bob']
    )
    expect(JSON.parse(updated)).toEqual({
      kind: 'Model',
      spec: { modelType: 'llm', allowedUsers: ['alice', 'bob'] },
    })

    const cleared = setPublicModelAllowedUsersInConfig(updated, [])
    expect(JSON.parse(cleared)).toEqual({
      kind: 'Model',
      spec: { modelType: 'llm' },
    })
  })

  test('leaves invalid JSON unchanged while editing', () => {
    const invalidJson = '{"spec":'
    expect(setPublicModelAllowedUsersInConfig(invalidJson, ['alice'])).toBe(invalidJson)
  })

  test('reads and writes spec.allowedUsersEnabled', () => {
    expect(
      getPublicModelAllowedUsersEnabledFromConfig(
        JSON.stringify({ kind: 'Model', spec: { allowedUsersEnabled: true } })
      )
    ).toBe(true)
    expect(
      getPublicModelAllowedUsersEnabledFromConfig(JSON.stringify({ kind: 'Model', spec: {} }))
    ).toBe(false)

    const enabled = setPublicModelAllowedUsersEnabledInConfig(
      JSON.stringify({ kind: 'Model', spec: { modelType: 'llm' } }),
      true
    )
    expect(JSON.parse(enabled)).toEqual({
      kind: 'Model',
      spec: { modelType: 'llm', allowedUsersEnabled: true },
    })

    const disabled = setPublicModelAllowedUsersEnabledInConfig(enabled, false)
    expect(JSON.parse(disabled)).toEqual({
      kind: 'Model',
      spec: { modelType: 'llm' },
    })
    expect(setPublicModelAllowedUsersEnabledInConfig('{"spec":', true)).toBe('{"spec":')
  })
})
