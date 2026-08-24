import { invoke } from '@tauri-apps/api/core'

export async function readInlineVisualizationHtml(path: string): Promise<string> {
  return invoke<string>('read_inline_visualization_html', { path })
}
