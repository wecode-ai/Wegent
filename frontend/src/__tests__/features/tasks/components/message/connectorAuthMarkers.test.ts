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

  test('extracts the app slug for a deterministic authorization link', () => {
    expect(
      connectorAuthSlug('暂时不可用。\n\nconnector_auth_required connectorSlug=dingding_todo')
    ).toBe('dingding_todo')
    expect(connectorAuthSlug('- `connectorSlug`: `dingtalk_log`')).toBe('dingtalk_log')
    expect(connectorAuthSlug('没有标记的普通回复')).toBeNull()
  })
})
