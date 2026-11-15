import { describe, expect, it } from 'vitest'
import { localRuntimeFileReference, withLocalRuntimeFileReferences } from './localRuntimeFiles'

describe('guest attachment file ownership', () => {
  it('qualifies streaming and restored attachments with the real phone device', () => {
    const input = {
      turns: [
        { messages: [{ attachments: [{ id: -1, local_path: '/root/attachments/note.txt' }] }] },
      ],
    }
    const output = withLocalRuntimeFileReferences(input, 'mobile-local:phone')
    expect(output.turns[0]!.messages[0]!.attachments[0]).toMatchObject({
      workspace_file: {
        device_id: 'mobile-local:phone',
        workspace_path: '/root/attachments',
        path: '/root/attachments/note.txt',
      },
    })
    expect(input.turns[0]!.messages[0]!.attachments[0]).not.toHaveProperty('workspace_file')
  })
  it('never treats a host URL or Backend attachment as a guest file', () => {
    const input = { attachments: [{ id: 3 }, { id: -1, local_path: 'file:///private/phone.txt' }] }
    expect(withLocalRuntimeFileReferences(input, 'phone')).toEqual(input)
    expect(() => localRuntimeFileReference('phone', '/root/../private')).toThrow('无效')
  })
})
