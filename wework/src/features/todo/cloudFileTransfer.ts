export async function readFileFromAccessUrl(url: string): Promise<Blob> {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`文件读取失败（HTTP ${response.status}）`)
  }
  return response.blob()
}

export async function saveBlobToDownloads(blob: Blob, filename: string): Promise<string> {
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
