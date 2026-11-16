import Foundation
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

enum RuntimePipeReadError: Error {
  case incompleteLine
}

enum RuntimePipeReader {
  // Foundation's read(upToCount:) can wait to fill its buffer on Darwin pipes.
  // POSIX read returns available bytes immediately, even while the writer lives.
  static func readChunks(from descriptor: Int32, bufferSize: Int = 65536,
                         onChunk: (Data) throws -> Void) throws {
    precondition(bufferSize > 0)
    var storage = Data(count: bufferSize)
    while true {
      let count = storage.withUnsafeMutableBytes { bytes in
        read(descriptor, bytes.baseAddress, bufferSize)
      }
      if count > 0 { try onChunk(storage.prefix(count)); continue }
      if count == 0 { return }
      let code = errno
      if code == EINTR { continue }
      throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
    }
  }

  static func readLines(from descriptor: Int32, bufferSize: Int = 65536,
                        onLine: (Data) throws -> Void) throws {
    var buffer = Data()
    try readChunks(from: descriptor, bufferSize: bufferSize) { chunk in
      buffer.append(chunk)
      while let newline = buffer.firstIndex(of: 10) {
        let line = Data(buffer[..<newline])
        buffer.removeSubrange(...newline)
        if !line.isEmpty { try onLine(line) }
      }
    }
    if !buffer.isEmpty { throw RuntimePipeReadError.incompleteLine }
  }
}
