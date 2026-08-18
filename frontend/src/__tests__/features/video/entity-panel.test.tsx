// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { fireEvent, render, screen } from '@testing-library/react'
import { EntityPanel } from '@/features/video/entity/EntityPanel'
import { entityApis } from '@/features/video/entity/api'

jest.mock('@/features/video/entity/api', () => ({
  entityApis: {
    listEntities: jest.fn(),
  },
}))

jest.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'entity.character': '角色',
        'entity.scene': '场景',
        'entity.prop': '道具',
        'entity.continue': '开始生成分镜',
      })[key] || key,
  }),
}))

const mockListEntities = entityApis.listEntities as jest.MockedFunction<
  typeof entityApis.listEntities
>

describe('EntityPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('loads generated entity images through the authenticated media proxy', async () => {
    const imageUrl = 'https://wx1.sinaimg.cn/large/character.jpg'
    mockListEntities.mockResolvedValue({
      characters: [
        {
          id: 101,
          entity_id: 'character-1',
          entity_name: '星际观察员',
          entity_type: 1,
          description: '站在深空观测站中的年轻观察员',
          image_pid: 'character-pid',
          image_url: imageUrl,
          generation_status: 2,
        },
      ],
      scenes: [],
      props: [],
    })

    render(<EntityPanel taskId={27} />)

    expect(await screen.findByTestId('entity-panel')).toBeInTheDocument()
    expect(mockListEntities).toHaveBeenCalledWith(27)
    expect(screen.getByTestId('entity-image-101')).toHaveAttribute(
      'src',
      `/api/aigc-video/media/image?image_url=${encodeURIComponent(imageUrl)}`
    )
    expect(screen.getAllByText('星际观察员')).toHaveLength(2)
    expect(screen.getByText('站在深空观测站中的年轻观察员')).toBeInTheDocument()
  })

  test('switches images from the thumbnail list and continues the async-card flow', async () => {
    const onContinue = jest.fn()
    mockListEntities.mockResolvedValue({
      characters: [],
      scenes: [
        {
          id: 201,
          entity_id: 'scene-1',
          entity_name: '深空观测站',
          entity_type: 2,
          description: null,
          image_pid: 'scene-pid',
          image_url: 'https://wx1.sinaimg.cn/large/scene.jpg',
          generation_status: 2,
        },
      ],
      props: [
        {
          id: 301,
          entity_id: 'prop-1',
          entity_name: '星空接收器',
          entity_type: 3,
          description: null,
          image_pid: 'prop-pid',
          image_url: 'https://wx2.sinaimg.cn/large/prop.jpg',
          generation_status: 2,
        },
      ],
    })

    render(<EntityPanel taskId={27} onContinue={onContinue} />)
    await screen.findByTestId('entity-panel')

    fireEvent.click(screen.getByTestId('entity-thumbnail-301'))
    expect(screen.getByTestId('entity-image-301')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('entity-continue'))
    expect(onContinue).toHaveBeenCalledWith('开始生成分镜')
  })
})
