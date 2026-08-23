import { invoke } from '@tauri-apps/api/core'
import { readElectronLocalFile } from '@/lib/electron-local-file'
import { isElectronRuntime } from '@/lib/runtime-environment'

export async function readInlineVisualizationHtml(path: string): Promise<string> {
  if (isElectronRuntime()) {
    return new TextDecoder().decode(await readElectronLocalFile(path))
  }
  return invoke<string>('read_inline_visualization_html', { path })
}
