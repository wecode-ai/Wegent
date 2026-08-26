import { readElectronLocalFile } from '@/lib/electron-local-file'

export interface SelectedDeliveryFile {
  file: File
  relativePath: string
}

export async function readSelectedDeliveryFiles(paths: string[]): Promise<SelectedDeliveryFile[]> {
  return Promise.all(
    paths.map(async path => ({
      file: new File([await readElectronLocalFile(path)], path.split(/[\\/]/).at(-1) || 'file'),
      relativePath: path.split(/[\\/]/).at(-1) || 'file',
    }))
  )
}

export async function readDroppedFiles(paths: string[]): Promise<File[]> {
  return (await readSelectedDeliveryFiles(paths)).map(item => item.file)
}
