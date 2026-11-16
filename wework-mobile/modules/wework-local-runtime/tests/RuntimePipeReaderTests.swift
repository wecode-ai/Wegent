import Foundation
import Dispatch
#if canImport(Darwin)
import Darwin
#else
import Glibc
#endif

private final class ReadResult: @unchecked Sendable {
  private let lock = NSLock()
  private var lines: [Data] = []
  private var failure: Error?
  func append(_ line: Data) { lock.withLock { lines.append(line) } }
  func fail(_ error: Error) { lock.withLock { failure = error } }
  func snapshot() -> ([Data], Error?) { lock.withLock { (lines, failure) } }
}

@main
struct RuntimePipeReaderTests {
  static func main() throws {
    try shortFrameArrivesWhileWriterRemainsOpen()
    try splitAndCoalescedFramesRetainBoundaries()
    try eofRequiresACompleteFrame()
    readErrorsRemainObservable()
    try consumerFailureDoesNotCloseTheDescriptor()
    print("PASS native pipe short reads, frame boundaries, EOF, errors, and descriptor ownership")
  }

  private static func shortFrameArrivesWhileWriterRemainsOpen() throws {
    let pipe = Pipe()
    let received = DispatchSemaphore(value: 0)
    let finished = DispatchSemaphore(value: 0)
    let result = ReadResult()
    let frame = Data("{\"event\":\"executor.ready\"}".utf8)
    DispatchQueue.global().async {
      defer { finished.signal() }
      do {
        try RuntimePipeReader.readLines(from: pipe.fileHandleForReading.fileDescriptor) {
          result.append($0); received.signal()
        }
      } catch { result.fail(error) }
    }
    try pipe.fileHandleForWriting.write(contentsOf: frame + Data([10]))
    // Closing the writer only after this wait detects Foundation's fill-or-EOF
    // behavior without leaving a failed regression test's reader blocked.
    let arrivedBeforeEOF = received.wait(timeout: .now() + 1) == .success
    try pipe.fileHandleForWriting.close()
    precondition(finished.wait(timeout: .now() + 2) == .success)
    try pipe.fileHandleForReading.close()
    precondition(arrivedBeforeEOF, "A short ready frame must arrive before pipe EOF")
    let (lines, error) = result.snapshot()
    precondition(lines == [frame] && error == nil)
  }

  private static func splitAndCoalescedFramesRetainBoundaries() throws {
    for bufferSize in [4, 65536] {
      let pipe = Pipe()
      let finished = DispatchSemaphore(value: 0)
      let result = ReadResult()
      let first = Data("{\"event\":\"executor.ready\"}".utf8)
      let second = Data("{\"type\":\"response\",\"ok\":true}".utf8)
      DispatchQueue.global().async {
        defer { finished.signal() }
        do {
          try RuntimePipeReader.readLines(from: pipe.fileHandleForReading.fileDescriptor,
                                          bufferSize: bufferSize) { result.append($0) }
        } catch { result.fail(error) }
      }
      // Four-byte reads force frames across multiple chunks; the full-size
      // read can receive both frames together. Empty lines carry no IPC frame.
      try pipe.fileHandleForWriting.write(contentsOf: first + Data([10, 10]) + second + Data([10]))
      try pipe.fileHandleForWriting.close()
      precondition(finished.wait(timeout: .now() + 2) == .success)
      try pipe.fileHandleForReading.close()
      let (lines, error) = result.snapshot()
      precondition(lines == [first, second] && error == nil)
    }
  }

  private static func eofRequiresACompleteFrame() throws {
    let empty = Pipe()
    try empty.fileHandleForWriting.close()
    try RuntimePipeReader.readLines(from: empty.fileHandleForReading.fileDescriptor) { _ in
      preconditionFailure("An empty pipe must not fabricate a frame")
    }
    try empty.fileHandleForReading.close()

    let partial = Pipe()
    defer { try? partial.fileHandleForReading.close() }
    try partial.fileHandleForWriting.write(contentsOf: Data("{\"unfinished\":".utf8))
    try partial.fileHandleForWriting.close()
    do {
      try RuntimePipeReader.readLines(from: partial.fileHandleForReading.fileDescriptor) { _ in
        preconditionFailure("An unterminated frame must not be delivered")
      }
      preconditionFailure("EOF must reject an incomplete frame")
    } catch RuntimePipeReadError.incompleteLine { }
  }

  private static func readErrorsRemainObservable() {
    do {
      try RuntimePipeReader.readChunks(from: -1) { _ in
        preconditionFailure("An invalid descriptor cannot produce bytes")
      }
      preconditionFailure("A read error must not be interpreted as EOF")
    } catch {
      let failure = error as NSError
      precondition(failure.domain == NSPOSIXErrorDomain && failure.code == Int(EBADF))
    }
  }

  private static func consumerFailureDoesNotCloseTheDescriptor() throws {
    enum ConsumerFailure: Error { case rejected }
    let pipe = Pipe()
    defer {
      try? pipe.fileHandleForReading.close()
      try? pipe.fileHandleForWriting.close()
    }
    try pipe.fileHandleForWriting.write(contentsOf: Data("frame\n".utf8))
    do {
      try RuntimePipeReader.readLines(from: pipe.fileHandleForReading.fileDescriptor) { _ in
        throw ConsumerFailure.rejected
      }
      preconditionFailure("The consumer error must propagate")
    } catch ConsumerFailure.rejected { }
    precondition(fcntl(pipe.fileHandleForReading.fileDescriptor, F_GETFD) != -1,
      "Only the FileHandle owner may close the descriptor")
  }
}
