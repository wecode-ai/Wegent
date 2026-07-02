import type { ExternalKbNode } from '@wecode/types/external-knowledge'
import { getExternalKnowledgePreview } from '@wecode/api/external-knowledge'
import {
  getExternalFolderRequestId,
  getExternalTypedIdRawValue,
  isExternalChildOfFolder,
  isMissingEmployeeError,
  resolveExternalNodePreview,
} from '@wecode/features/knowledge/external/utils'

jest.mock('@wecode/api/external-knowledge', () => ({
  getExternalKnowledgePreview: jest.fn(),
  listExternalKnowledgeBases: jest.fn(),
}))

const mockGetPreview = getExternalKnowledgePreview as jest.MockedFunction<
  typeof getExternalKnowledgePreview
>

describe('external knowledge node utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('uses raw folder ids for provider list-nodes requests', () => {
    const folders: ExternalKbNode[] = [
      {
        node_id: 'folder:folder-1',
        raw_id: 'folder-1',
        name: 'Folder',
        node_type: 'folder',
      },
    ]

    expect(getExternalFolderRequestId('folder:folder-1', folders)).toBe('folder-1')
  })

  it('strips typed node prefixes when raw_id is unavailable', () => {
    expect(getExternalFolderRequestId('folder:folder-2', [])).toBe('folder-2')
  })

  it('strips typed id prefixes for preview folder requests', () => {
    expect(getExternalTypedIdRawValue('folder:folder-3')).toBe('folder-3')
    expect(getExternalTypedIdRawValue('folder-4')).toBe('folder-4')
    expect(getExternalTypedIdRawValue(null)).toBeNull()
  })

  it('matches children whose parent_id uses the parent raw id', () => {
    const parent: ExternalKbNode = {
      node_id: 'folder:folder-1',
      raw_id: 'folder-1',
      name: 'Parent',
      node_type: 'folder',
    }
    const child: ExternalKbNode = {
      node_id: 'folder:folder-2',
      raw_id: 'folder-2',
      parent_id: 'folder-1',
      name: 'Child',
      node_type: 'folder',
    }

    expect(isExternalChildOfFolder(child, parent)).toBe(true)
  })

  it('recognizes the backend employee-id-required code', () => {
    expect(isMissingEmployeeError({ status: 403, code: 'employee_id_required' })).toBe(true)
  })

  it('uses node preview metadata without a second preview request', async () => {
    const preview = {
      url: 'https://apgateway.erp.sina.com.cn/raw',
      preview_mode: 'iframe' as const,
    }
    await expect(
      resolveExternalNodePreview(
        'ap',
        {
          provider: 'ap',
          knowledge_base_id: 'kb-1',
          knowledge_base_name: 'Knowledge',
        },
        {
          node_id: 'document:doc-1',
          raw_id: 'doc-1',
          name: 'Plan.pdf',
          node_type: 'document',
          preview,
        }
      )
    ).resolves.toBe(preview)
    expect(mockGetPreview).not.toHaveBeenCalled()
  })

  it('falls back to the preview endpoint when node preview metadata is absent', async () => {
    mockGetPreview.mockResolvedValue({
      url: 'https://agent.test.erp.sina.com.cn/preview',
      preview_mode: 'new_tab',
    })

    await expect(
      resolveExternalNodePreview(
        'ap',
        {
          provider: 'ap',
          knowledge_base_id: 'kb-1',
          knowledge_base_name: 'Knowledge',
        },
        {
          node_id: 'document:doc-1',
          raw_id: 'doc-1',
          parent_id: 'folder:folder-1',
          name: 'Plan.pdf',
          node_type: 'document',
        }
      )
    ).resolves.toEqual({
      url: 'https://agent.test.erp.sina.com.cn/preview',
      preview_mode: 'new_tab',
    })
    expect(mockGetPreview).toHaveBeenCalledWith('ap', {
      kb_id: 'kb-1',
      node_id: 'document:doc-1',
      folder_id: 'folder-1',
    })
  })
})
