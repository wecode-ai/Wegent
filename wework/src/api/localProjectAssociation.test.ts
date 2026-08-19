import { describe, expect, it } from 'vitest'
import {
  associateLoopItemTags,
  localProjectAssociationFromTags,
  localProjectAssociationTag,
  visibleLoopItemTags,
} from './localProjectAssociation'

describe('local project association', () => {
  it('replaces the internal project association without changing visible tags', () => {
    expect(
      associateLoopItemTags(
        { tags: ['bug', 'wegent:local-project:1:old', 'desktop'] },
        { id: 2, name: 'Wegent 桌面端' }
      )
    ).toEqual(['bug', 'desktop', 'wegent:local-project:2:Wegent%20%E6%A1%8C%E9%9D%A2%E7%AB%AF'])
  })

  it('round-trips a local project through a hidden system tag', () => {
    const tag = localProjectAssociationTag({ id: 91, name: 'Wegent 中文' })

    expect(localProjectAssociationFromTags(['feature', tag])).toEqual({
      id: 91,
      name: 'Wegent 中文',
    })
    expect(visibleLoopItemTags(['feature', tag])).toEqual(['feature'])
  })
})
