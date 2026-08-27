export { saveBlobToDownloads } from '@/lib/blobDownload'

export async function readFileFromAccessUrl(url: string): Promise<Blob> {
  const response = await globalThis.fetch(url)
  if (!response.ok) {
    throw new Error(`文件读取失败（HTTP ${response.status}）`)
  }
  return response.blob()
}
