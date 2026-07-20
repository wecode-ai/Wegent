import { invoke } from '@tauri-apps/api/core'

interface NativeDroppedFile {
  name: string
  bytes: number[]
}

export async function readDroppedFiles(paths: string[]): Promise<File[]> {
  const files = await invoke<NativeDroppedFile[]>('read_dropped_files', { paths })
  return files.map(file => new File([new Uint8Array(file.bytes)], file.name))
}
