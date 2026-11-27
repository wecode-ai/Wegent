export type ReleaseBlock = [bytes: number, sha256: string]
export interface ReleaseBlockMap {
  sha256: string
  bytes: number
}
export function validReleaseBlockMap(input: unknown): input is ReleaseBlockMap
export function encodeReleaseBlocks(blocks: ReleaseBlock[]): Buffer
export function decodeReleaseBlocks(
  index: Buffer,
  map: ReleaseBlockMap,
  archiveBytes: number
): ReleaseBlock[]
