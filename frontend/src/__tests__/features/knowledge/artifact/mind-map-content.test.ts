// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  buildMindMapQuestion,
  getMindMapNodePath,
  parseMindMapContent,
} from '@/features/knowledge/artifact/components/mindMapContent'

const content = JSON.stringify({
  schema_version: 1,
  root_id: 'root',
  nodes: [
    { id: 'root', parent_id: null, title: 'AB 实验' },
    { id: 'flow', parent_id: 'root', title: '创建流程' },
    { id: 'filter', parent_id: 'flow', title: '过滤条件' },
  ],
})

describe('mind map content', () => {
  it('parses a connected structured tree', () => {
    const parsed = parseMindMapContent(content)

    expect(parsed?.root_id).toBe('root')
    expect(parsed?.nodes).toHaveLength(3)
  })

  it('rejects legacy Mermaid and cyclic data', () => {
    expect(parseMindMapContent('mindmap\n  root((主题))')).toBeNull()
    expect(
      parseMindMapContent(
        JSON.stringify({
          schema_version: 1,
          root_id: 'root',
          nodes: [
            { id: 'root', parent_id: null, title: '主题' },
            { id: 'a', parent_id: 'b', title: 'A' },
            { id: 'b', parent_id: 'a', title: 'B' },
          ],
        })
      )
    ).toBeNull()
  })

  it('builds a visible prompt with the full node path', () => {
    const parsed = parseMindMapContent(content)!
    const t = (key: string, options?: Record<string, string>) =>
      ({
        'artifact.mindMap.question': `Explain ${options?.title}`,
        'artifact.mindMap.path': `Path: ${options?.path}`,
        'artifact.mindMap.instruction': 'Cite sources',
      })[key] ?? key

    expect(getMindMapNodePath(parsed, 'filter').map(node => node.title)).toEqual([
      'AB 实验',
      '创建流程',
      '过滤条件',
    ])
    expect(buildMindMapQuestion(parsed, 'filter', t)).toBe(
      'Explain 过滤条件\nPath: AB 实验 > 创建流程 > 过滤条件\nCite sources'
    )
  })
})
