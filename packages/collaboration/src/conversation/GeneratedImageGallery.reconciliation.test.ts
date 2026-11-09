import { describe, expect, it } from 'vitest'
import type { RuntimeConversationTurn } from '@wegent/chat-core/runtime-conversation'
import {
  mergeRuntimeConversationTurns,
  projectRuntimeConversationTurns,
} from '@wegent/chat-core/runtime-conversation-turns'
import { getGeneratedImages } from './GeneratedImageGallery'

const artifact = {
  kind: 'image_generation',
  mimeType: 'image/png',
  source: {
    type: 'workspace_file',
    deviceId: 'device-1',
    workspacePath: '/workspace',
    path: 'outputs/generated-images/first.png',
  },
  width: 4,
  height: 2,
  size: 80,
}

function image(
  payload: Record<string, unknown> | undefined,
  { id = 'image-1', turnId = 'turn-1', status = 'done' }: {
    id?: string
    turnId?: string
    status?: 'done' | 'error'
  } = {}
): RuntimeConversationTurn {
  return {
    id: turnId,
    status: 'done',
    items: [
      {
        id,
        type: 'block',
        block: {
          id,
          type: 'tool',
          toolName: 'image_generation',
          status,
          createdAt: 1,
          renderPayload: payload,
        },
      },
    ],
  }
}

function visibleImages(turns: RuntimeConversationTurn[]) {
  return projectRuntimeConversationTurns(turns).flatMap(message =>
    getGeneratedImages(message.blocks ?? [], 'Generated image')
  )
}

describe('generated image history reconciliation', () => {
  it.each([undefined, { kind: 'image_generation' }])(
    'keeps a completed artifact visible through an omitted artifact snapshot (%j) and recovery',
    payload => {
      const live = image(artifact)
      expect(visibleImages([live])).toHaveLength(1)
      const thin = mergeRuntimeConversationTurns([live], [image(payload)])
      expect(visibleImages(thin)).toEqual(visibleImages([live]))
      const recovered = mergeRuntimeConversationTurns(thin, [image(artifact)])
      expect(visibleImages(recovered)).toEqual(visibleImages([live]))
    }
  )

  it('takes a newly supplied artifact as authoritative', () => {
    const replacement = { ...artifact, source: { ...artifact.source, path: 'second.png' } }
    const merged = mergeRuntimeConversationTurns([image(artifact)], [image(replacement)])
    expect(visibleImages(merged)[0].workspaceFile?.path).toBe('second.png')
  })

  it('does not assign an earlier artifact to another image ID', () => {
    const merged = mergeRuntimeConversationTurns(
      [image(artifact)],
      [image({ kind: 'image_generation' }, { id: 'image-2' })]
    )
    expect(visibleImages(merged).map(item => item.id)).toEqual(['image-1'])
  })

  it('does not carry an artifact into another generation reusing the same item ID', () => {
    const merged = mergeRuntimeConversationTurns(
      [image(artifact)],
      [image({ kind: 'image_generation' }, { turnId: 'turn-2' })]
    )
    expect(visibleImages(merged.filter(turn => turn.id === 'turn-2'))).toEqual([])
  })

  it('does not restore a failed image or an explicitly cleared artifact', () => {
    for (const snapshot of [
      image({ kind: 'image_generation' }, { status: 'error' }),
      image({ kind: 'image_generation', source: null }),
    ]) {
      expect(visibleImages(mergeRuntimeConversationTurns([image(artifact)], [snapshot]))).toEqual(
        []
      )
    }
  })

  it.each([{}, { type: 'workspace_file', path: 'incomplete.png' }])(
    'does not preserve an artifact reference that was never renderable (%j)',
    source => {
      const previous = image({ kind: 'image_generation', source })
      expect(visibleImages([previous])).toEqual([])
      const merged = mergeRuntimeConversationTurns(
        [previous],
        [image({ kind: 'image_generation' })]
      )
      expect(projectRuntimeConversationTurns(merged)[0].blocks?.[0]).toMatchObject({
        renderPayload: { kind: 'image_generation' },
      })
      expect(projectRuntimeConversationTurns(merged)[0].blocks?.[0]).not.toHaveProperty(
        'renderPayload.source'
      )
    }
  )
})
