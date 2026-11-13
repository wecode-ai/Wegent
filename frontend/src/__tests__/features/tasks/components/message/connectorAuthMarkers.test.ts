// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { connectorAuthSlug, stripConnectorAuthMarkers } from '@/lib/connectorAuthMarkers'

describe('stripConnectorAuthMarkers', () => {
  test('removes trailing markers printed on the last line', () => {
    expect(
      stripConnectorAuthMarkers(
        '钉钉待办还没有授权。\n\nconnector_auth_required connectorSlug=dingding_todo'
      )
    ).toBe('钉钉待办还没有授权。')
  })

  test('removes markers that occupy their own lines', () => {
    expect(
      stripConnectorAuthMarkers(
        '请先完成授权。\nconnector_auth_required\npluginKey=github\nconnectorSlug=wework-github-cli'
      )
    ).toBe('请先完成授权。')
  })

  test('removes markers wrapped in backticks or bullet lists', () => {
    expect(
      stripConnectorAuthMarkers(
        '需要授权。\n\n- `connector_auth_required`\n- `connectorSlug`: `dingtalk_log`'
      )
    ).toBe('需要授权。')
  })

  test('keeps the surrounding sentence when the marker is inline', () => {
    expect(
      stripConnectorAuthMarkers(
        '请先授权 connector_auth_required connectorSlug=dingtalk_todo 后继续。'
      )
    ).toBe('请先授权 后继续。')
  })

  test('leaves ordinary replies untouched', () => {
    const text = '已完成，共 3 条记录。\n\n需要继续吗？'
    expect(stripConnectorAuthMarkers(text)).toBe(text)
  })

  test.each([
    'The connector_auth_required flag is set.',
    'Both connector_auth_required need_login flags are documented.',
    '普通正文 connector_auth_required 后面的内容需要保留。',
    'Keep  connector_auth_required  and every space.\nconnectorSlug=example',
  ])('preserves ordinary mentions byte-exact: %s', text => {
    expect(stripConnectorAuthMarkers(text)).toBe(text)
    expect(connectorAuthSlug(text)).toBeNull()
  })

  test('extracts the app slug for a deterministic authorization link', () => {
    expect(
      connectorAuthSlug('暂时不可用。\n\nconnector_auth_required connectorSlug=dingding_todo')
    ).toBe('dingding_todo')
    expect(connectorAuthSlug('没有标记的普通回复')).toBeNull()
    expect(connectorAuthSlug('connectorSlug=dingtalk_log')).toBeNull()
  })

  test('preserves marker examples inside fenced and inline code', () => {
    const text = [
      'Use `connector_auth_required connectorSlug=demo` in code.',
      '```text',
      'connector_auth_required',
      'connectorSlug=demo',
      '```',
      'End.',
    ].join('\n')

    expect(stripConnectorAuthMarkers(text)).toBe(text)
    expect(connectorAuthSlug(text)).toBeNull()
  })

  test('uses the real marker instead of the slug in an earlier code example', () => {
    const example = 'Example: `connector_auth_required connectorSlug=demo`.'
    const text = `${example}\n\nconnector_auth_required connectorSlug=actual`
    expect(connectorAuthSlug(text)).toBe('actual')
    expect(stripConnectorAuthMarkers(text)).toBe(example)
  })

  test.each([
    ['````text', '```'],
    ['~~~text', '```'],
    ['```text', '```not-a-closing-fence'],
  ])('preserves code until the matching fence closes: %s', (opening, inner) => {
    const code = `${opening}\n${inner}\nconnector_auth_required connectorSlug=demo`
    expect(stripConnectorAuthMarkers(code)).toBe(code)
    expect(connectorAuthSlug(code)).toBeNull()
  })

  test('preserves long inline code delimiters and indented code', () => {
    const text = [
      'Example: ``a ` connector_auth_required connectorSlug=demo``.',
      '',
      '    connector_auth_required connectorSlug=indented',
    ].join('\n')
    expect(stripConnectorAuthMarkers(text)).toBe(text)
    expect(connectorAuthSlug(text)).toBeNull()
  })

  test('does not corrupt unrelated prose or code when a real marker is present', () => {
    const prose = [
      'The need_login flag is true.',
      'The field connectorSlug: string names the connector.',
      '```ts',
      'connectorSlug: string',
      '```',
      '',
      '',
      'Keep  these spaces.',
    ].join('\n')
    const text = `${prose}\n\nconnector_auth_required connectorSlug=actual`
    expect(stripConnectorAuthMarkers(text)).toBe(prose)
    expect(connectorAuthSlug(text)).toBe('actual')
  })

  test('extracts the slug from bullet-wrapped protocol lines', () => {
    const text = '需要授权。\n\n- `connector_auth_required`\n- `connectorSlug`: `actual`'
    expect(connectorAuthSlug(text)).toBe('actual')
    expect(stripConnectorAuthMarkers(text)).toBe('需要授权。')
  })

  test.each([
    '> ```text\n> connector_auth_required connectorSlug=demo\n> ```',
    '<pre>\n\nconnector_auth_required connectorSlug=demo\n\n</pre>',
    '```\nconnector_auth_required connectorSlug=demo\n```',
  ])('preserves literal examples followed by a real marker: %s', example => {
    const text = `${example}\n\nconnector_auth_required connectorSlug=actual`
    expect(stripConnectorAuthMarkers(text)).toBe(example)
    expect(connectorAuthSlug(text)).toBe('actual')
  })
})
