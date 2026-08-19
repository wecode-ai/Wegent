import { invoke } from '@tauri-apps/api/core'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { isTauriRuntime } from '@/lib/runtime-environment'

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

export async function readFileFromAccessUrl(url: string): Promise<Blob> {
  const response =
    isTauriRuntime() && isHttpUrl(url) ? await tauriFetch(url) : await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`文件读取失败（HTTP ${response.status}）`)
  }
  return response.blob()
}

export async function saveBlobToDownloads(blob: Blob, filename: string): Promise<string> {
  if (isTauriRuntime()) {
    return invoke<string>('save_binary_file_to_downloads', {
      filename,
      bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    })
  }

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  return filename
}
