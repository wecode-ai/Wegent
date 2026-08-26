import { readElectronLocalFile } from '@/lib/electron-local-file'

export async function readInlineVisualizationHtml(path: string): Promise<string> {
  return new TextDecoder().decode(await readElectronLocalFile(path))
}
