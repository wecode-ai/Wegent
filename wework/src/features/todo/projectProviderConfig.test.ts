import { describe, expect, it } from 'vitest'
import { parseDingTalkAITableLink, repositoryProviderConfig } from './projectProviderConfig'

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
