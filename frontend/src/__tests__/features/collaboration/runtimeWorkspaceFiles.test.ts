import { deviceApis } from '@/apis/devices'
import { readRuntimeWorkspaceFile } from '@/features/collaboration/runtimeWorkspaceFiles'

jest.mock('@/apis/devices', () => ({ deviceApis: { executeCommand: jest.fn() } }))

const reference = {
  device_id: 'remote-device',
  workspace_path: '/workspace/project',
  path: 'out/image.png',
}
const command = jest.mocked(deviceApis.executeCommand)
const chunk = (offset: number, content: string, eof: boolean, size = 4) => ({
  success: true,
  stderr: '',
  duration: 0,
  stdout: {
    path: '/resolved/project/out/image.png',
    name: 'image.png',
    content_base64: btoa(content),
    offset,
    eof,
    size,
  },
})

afterEach(() => jest.resetAllMocks())

test('reads all chunks through the bound device and preserves the attachment MIME type', async () => {
  command.mockResolvedValueOnce(chunk(0, 'ab', false)).mockResolvedValueOnce(chunk(2, 'cd', true))
  const blob = await readRuntimeWorkspaceFile(reference, 'image/png')
  expect(blob.type).toBe('image/png')
  expect(blob.size).toBe(4)
  expect(command.mock.calls).toEqual(
    [0, 2].map(offset => [
      'remote-device',
      {
        command_key: 'workspace_read_file_chunk',
        path: '/workspace/project/out',
        args: ['image.png', String(offset)],
        timeout_seconds: 30,
        max_output_bytes: 2097152,
      },
    ])
  )
})

test('surfaces device failures instead of creating an empty preview', async () => {
  command.mockResolvedValue({ success: false, stderr: 'Device offline', stdout: '', duration: 0 })
  await expect(readRuntimeWorkspaceFile(reference)).rejects.toThrow('Device offline')
})

test('rejects a truncated final chunk and a file whose size changes during the read', async () => {
  command.mockResolvedValueOnce(chunk(0, 'ab', true))
  await expect(readRuntimeWorkspaceFile(reference)).rejects.toThrow('complete file')
  command
    .mockResolvedValueOnce(chunk(0, 'ab', false))
    .mockResolvedValueOnce(chunk(2, 'cd', true, 8))
  await expect(readRuntimeWorkspaceFile(reference)).rejects.toThrow('invalid workspace image chunk')
})
