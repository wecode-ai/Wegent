// Stub for rehype plugins to avoid ESM issues in Jest
// This provides no-op implementations for rehype plugins

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function rehypeStub(_options?: any) {
  // Return a no-op transformer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function transformer(_tree: any) {
    // No transformation
  }
}
