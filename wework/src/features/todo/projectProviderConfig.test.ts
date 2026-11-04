// @vitest-environment node

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { describe, expect, it } from 'vitest'
import { dingtalkAITableRuntimeContext, parseDingTalkAITableLink } from './projectProviderConfig'

describe('parseDingTalkAITableLink', () => {
  it('rejects unrelated or incomplete links', () => {
    expect(parseDingTalkAITableLink('https://example.com/i/nodes/base?sheetId=table')).toBeNull()
    expect(parseDingTalkAITableLink('https://alidocs.dingtalk.com/i/nodes/base')).toBeNull()
  })
})

describe('dingtalkAITableRuntimeContext', () => {
  it('routes AI Table work through project-space tools with stable identifiers', () => {
    const context = dingtalkAITableRuntimeContext({
      id: 'space-1',
      name: 'DingTalk tasks',
      project_key: 'DING',
      task_provider: 'dingtalk_aitable',
      provider_config: {
        base_id: 'base-1',
        table_id: 'table-1',
        view_id: 'view-1',
        board_mapping: { title_field_id: 'field-title' },
        credential_configured: true,
      },
    } as CloudProject)

    expect(context?.dingtalkAITableProject.kind).toBe('application')
    expect(context?.dingtalkAITableProject.value).toContain(
      '<project_resource_binding version="1">'
    )
    expect(context?.dingtalkAITableProject.value).toContain('"space_id": "space-1"')
    expect(context?.dingtalkAITableProject.value).toContain('"base_id": "base-1"')
    expect(context?.dingtalkAITableProject.value).toContain('"table_id": "table-1"')
    expect(context?.dingtalkAITableProject.value).toContain('"view_id": "view-1"')
    expect(context?.dingtalkAITableProject.value).toContain(
      '"named_space_reference": "list_spaces_then_use_that_space_binding"'
    )
    expect(context?.dingtalkAITableProject.value).toContain(
      '"explicit_dingtalk_search": "allow_provider_search"'
    )
    expect(context?.dingtalkAITableProject.value).toContain('"title_field_id": "field-title"')
    expect(context?.dingtalkAITableProject.value).toContain('use the wework_space tools')
    expect(context?.dingtalkAITableProject.value).toContain(
      'do not silently switch to another table'
    )
    expect(context?.dingtalkAITableProject.value).not.toContain('credential')
  })

  it('binds the current record and requires a full native DWS read', () => {
    const context = dingtalkAITableRuntimeContext(
      {
        id: 'space-1',
        name: 'DingTalk tasks',
        project_key: 'DING',
        task_provider: 'dingtalk_aitable',
        provider_config: {
          base_id: 'base-1',
          table_id: 'table-1',
        },
      } as CloudProject,
      {
        id: 'aitable:DING:record-1',
        source_record_id: 'record-1',
        title: '新模型接入',
        description: '',
        source_cells: { title: '新模型接入', owner: '刘亚飞' },
      } as CloudLoopItem
    )

    const value = context?.dingtalkAITableProject.value ?? ''
    expect(value).toContain('"record_id": "record-1"')
    expect(value).toContain('"cached_cells"')
    expect(value).toContain('call wework_space get_current_context first')
    expect(value).toContain('bundled_dws_fallback')
    expect(value).toContain('Never invoke a bare dws command')
    expect(value).not.toContain('$DWS_BINARY_PATH')
  })
})
