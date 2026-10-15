import { readElectronLocalFile } from '@/lib/electron-local-file'
import { rememberNativeFilePath } from './nativeFilePaths'

export interface SelectedDeliveryFile {
  file: File
  relativePath: string
}

export async function readSelectedDeliveryFiles(paths: string[]): Promise<SelectedDeliveryFile[]> {
  return Promise.all(
    paths.map(async path => {
      const filename = path.split(/[\\/]/).at(-1) || 'file'
      const file = new File([await readElectronLocalFile(path)], filename)
      rememberNativeFilePath(file, path)
      return { file, relativePath: filename }
    })
  )
}

export async function readDroppedFiles(paths: string[]): Promise<File[]> {
  return (await readSelectedDeliveryFiles(paths)).map(item => item.file)
}
