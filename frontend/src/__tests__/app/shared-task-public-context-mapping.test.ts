import { publicContextToSubtaskContextBrief } from '@/app/shared/task/public-context-mapping'
import type { PublicContextData } from '@/apis/tasks'

describe('shared task public context mapping', () => {
  it('maps external knowledge display fields without raw ids', () => {
    const context = publicContextToSubtaskContextBrief({
      id: 12,
      context_type: 'external_knowledge',
      name: 'Roadmap.md',
      status: 'ready',
      external_provider: 'dingtalk',
      external_provider_label: 'DingTalk',
      external_source_name: 'DingTalk Docs',
      external_target_name: 'Roadmap.md',
      external_target_type: 'document',
      retrieval_status: {
        searched: true,
        ignored: false,
      },
    } satisfies PublicContextData)

    expect(context).toEqual(
      expect.objectContaining({
        external_provider: 'dingtalk',
        external_provider_label: 'DingTalk',
        external_source_name: 'DingTalk Docs',
        external_target_name: 'Roadmap.md',
        external_target_type: 'document',
        retrieval_status: { searched: true, ignored: false },
      })
    )
    expect(context).not.toHaveProperty('external_ref')
    expect(context).not.toHaveProperty('external_node_id')
    expect(context).not.toHaveProperty('external_document_id')
    expect(context).not.toHaveProperty('external_parent_id')
  })
})
