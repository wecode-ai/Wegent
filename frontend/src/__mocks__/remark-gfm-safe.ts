// Mock for remark-gfm-safe to avoid ESM issues in Jest
// This is a simplified mock that returns a no-op plugin

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function remarkGfmSafe(_options?: any) {
  // Return a no-op transformer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function transformer(_tree: any) {
    // No transformation
  }
}
