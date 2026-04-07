// Stub for remark plugins to avoid ESM issues in Jest
// This provides no-op implementations for remark plugins

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function remarkStub(_options?: any) {
  // Return a no-op transformer
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return function transformer(_tree: any) {
    // No transformation
  }
}
