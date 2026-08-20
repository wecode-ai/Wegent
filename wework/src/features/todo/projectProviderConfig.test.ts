import { describe, expect, it } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import {
  dingtalkAITableRuntimeContext,
  parseDingTalkAITableLink,
  projectSpaceChatRuntimeContext,
  repositoryAddress,
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

  it('keeps the port for self-hosted GitLab and derives the API base from the origin', () => {
    expect(
      repositoryProviderConfig('https://gitlab.example.com:8443/hongyu91/tab-prompt', 'gitlab')
    ).toEqual({
      repository: 'hongyu91/tab-prompt',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com:8443/api/v4',
    })
  })

  it('parses the explicit API URL form for GitLab behind a relative URL root', () => {
    expect(
      repositoryProviderConfig(
        'https://gitlab.example.com/gitlab/api/v4/projects/weibo%2Fcommon%2Fwegent',
        'gitlab'
      )
    ).toEqual({
      repository: 'weibo/common/wegent',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com/gitlab/api/v4',
    })
  })

  it('parses the GitHub Enterprise API URL form', () => {
    expect(
      repositoryProviderConfig('https://ghe.example.com/api/v3/repos/owner/repository', 'github')
    ).toEqual({
      repository: 'owner/repository',
      domain: 'ghe.example.com',
      api_base: 'https://ghe.example.com/api/v3',
    })
  })

  it('collapses a gitlab.com API URL to the default configuration', () => {
    expect(
      repositoryProviderConfig('https://gitlab.com/api/v4/projects/group%2Fproject', 'gitlab')
    ).toEqual({ repository: 'group/project' })
  })

  it('does not mistake a nested group named api for an API URL', () => {
    expect(
      repositoryProviderConfig('https://gitlab.example.com/group/api/v4/project', 'gitlab')
    ).toEqual({
      repository: 'group/api/v4/project',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com/api/v4',
    })
  })

  it('keeps the self-hosted domain for SSH addresses', () => {
    expect(repositoryProviderConfig('git@gitlab.example.com:group/project.git', 'gitlab')).toEqual({
      repository: 'group/project',
      domain: 'gitlab.example.com',
      api_base: 'https://gitlab.example.com/api/v4',
    })
  })
})

describe('repositoryAddress', () => {
  it('reconstructs the default web URL from repository only', () => {
    expect(
      repositoryAddress({
        task_provider: 'gitlab',
        provider_config: { repository: 'group/project' },
      } as CloudProject)
    ).toBe('https://gitlab.com/group/project')
  })

  it('reconstructs the port from the stored API base', () => {
    expect(
      repositoryAddress({
        task_provider: 'gitlab',
        provider_config: {
          repository: 'group/project',
          domain: 'gitlab.example.com',
          api_base: 'https://gitlab.example.com:8443/api/v4',
        },
      } as CloudProject)
    ).toBe('https://gitlab.example.com:8443/group/project')
  })

  it('round-trips a relative URL root through the API address form', () => {
    expect(
      repositoryAddress({
        task_provider: 'gitlab',
        provider_config: {
          repository: 'group/project',
          domain: 'gitlab.example.com',
          api_base: 'https://gitlab.example.com/gitlab/api/v4',
        },
      } as CloudProject)
    ).toBe('https://gitlab.example.com/gitlab/api/v4/projects/group%2Fproject')
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

describe('projectSpaceChatRuntimeContext', () => {
  it('binds ordinary chat references to the current project board without enabling task mode', () => {
    const context = projectSpaceChatRuntimeContext({
      id: 'space-7',
      name: 'Local tasks',
      task_provider: 'local',
      provider_config: {},
    } as CloudProject)

    expect(context.projectSpaceChat.kind).toBe('application')
    expect(context.projectSpaceChat.value).toContain('<current_project_space>')
    expect(context.projectSpaceChat.value).toContain('{"id":"space-7","name":"Local tasks"}')
    expect(context.projectSpaceChat.value).toContain('use the configured project task-provider')
    expect(context).not.toHaveProperty('dingtalkAITableProject')
  })

  it('keeps the bound DingTalk provider instructions alongside the chat context', () => {
    const context = projectSpaceChatRuntimeContext({
      id: 'space-8',
      name: 'DingTalk tasks',
      project_key: 'DING',
      task_provider: 'dingtalk_aitable',
      provider_config: { base_id: 'base-1', table_id: 'table-1' },
    } as CloudProject)

    expect(context.projectSpaceChat.kind).toBe('application')
    expect(context.dingtalkAITableProject.kind).toBe('application')
  })
})
