import { describe, expect, it } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import {
  dingtalkAITableRuntimeContext,
  parseDingTalkAITableLink,
  repositoryProviderConfig,
} from './projectProviderConfig'

describe('repositoryProviderConfig', () => {
  it('removes GitLab web page suffixes from repository URLs', () => {
    expect(
      repositoryProviderConfig('https://gitlab.example.com/hongyu91/tab-prompt/-/issues', 'gitlab')
    ).toEqual({
      repository: 'hongyu91/tab-prompt',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com/api/v4',
    })
  })
})

describe('parseDingTalkAITableLink', () => {
  it('extracts the document node, sheet, and view from an Alidocs link', () => {
    const url =
      'https://alidocs.dingtalk.com/i/nodes/pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6?iframeQuery=entrance%3Ddata%26sheetId%3DhERWDMS%26viewId%3DqvGDAH2'
    expect(parseDingTalkAITableLink(url)).toEqual({
      baseId: 'pYLaezmVN63PAZGPTPKyr2X3VrMqPxX6',
      tableId: 'hERWDMS',
      viewId: 'qvGDAH2',
      url,
    })
  })

  it('rejects unrelated or incomplete links', () => {
    expect(parseDingTalkAITableLink('https://example.com/i/nodes/base?sheetId=table')).toBeNull()
    expect(parseDingTalkAITableLink('https://alidocs.dingtalk.com/i/nodes/base')).toBeNull()
  })
})

describe('dingtalkAITableRuntimeContext', () => {
  it('routes AI Table work to dws with stable project identifiers and no credentials', () => {
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
      '"explicit_dingtalk_search": "allow_dws_search"'
    )
    expect(context?.dingtalkAITableProject.value).toContain('"title_field_id": "field-title"')
    expect(context?.dingtalkAITableProject.value).toContain('the dws skill')
    expect(context?.dingtalkAITableProject.value).toContain(
      'do not silently switch to another table'
    )
    expect(context?.dingtalkAITableProject.value).not.toContain('credential')
  })

  it('does not inject DingTalk instructions for another provider', () => {
    expect(
      dingtalkAITableRuntimeContext({
        task_provider: 'local',
        provider_config: {},
      } as CloudProject)
    ).toBeUndefined()
  })
})
