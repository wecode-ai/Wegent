import { expect, test } from 'vitest'
import { readWorkspaceFileBytes } from './workspace-file-bytes'
import { splitAbsoluteWorkspaceFilePath } from './workspace-file-contract'

test.each([
  ['\\\\?\\D:\\workspace', 'D:/workspace'],
  ['\\\\?\\UNC\\server\\share\\workspace', '//server/share/workspace'],
])(
  'reads generated image bytes from a canonical Windows workspace %s',
  async (workspace, expectedRoot) => {
    const calls: string[] = []
    const bytes = await readWorkspaceFileBytes(
      {
        device_id: 'device',
        workspace_path: workspace,
        path: 'outputs/generated-images/image.png',
      },
      async (_device, filePath, offset, root) => {
        calls.push(filePath)
        expect(root).toBe(workspace)
        expect(splitAbsoluteWorkspaceFilePath(filePath)).toEqual({
          parentPath: `${expectedRoot}/outputs/generated-images`,
          fileName: 'image.png',
        })
        return {
          path: filePath,
          name: 'image.png',
          contentBase64: 'AQID',
          offset,
          eof: true,
          size: 3,
          modifiedAt: null,
        }
      },
    )
    expect(calls).toEqual([
      `${expectedRoot}/outputs/generated-images/image.png`,
    ])
    expect(Array.from(bytes)).toEqual([1, 2, 3])
  },
)
