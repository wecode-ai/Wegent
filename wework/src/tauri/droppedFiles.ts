import { invoke } from '@tauri-apps/api/core'

interface NativeDroppedFile {
  name: string
  relativePath: string
  bytes: number[]
}

export interface SelectedDeliveryFile {
  file: File
  relativePath: string
}

export async function readSelectedDeliveryFiles(paths: string[]): Promise<SelectedDeliveryFile[]> {
  const files = await invoke<NativeDroppedFile[]>('read_dropped_files', { paths })
  return files.map(file => ({
    file: new File([new Uint8Array(file.bytes)], file.name),
    relativePath: file.relativePath,
  }))
}

export async function readDroppedFiles(paths: string[]): Promise<File[]> {
  return (await readSelectedDeliveryFiles(paths)).map(item => item.file)
}
