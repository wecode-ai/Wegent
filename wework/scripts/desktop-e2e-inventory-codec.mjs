import LZString from 'lz-string'

// Keep the persisted inventory format identical to the renderer's codec.
export const decompressFromUTF16 = LZString.decompressFromUTF16
