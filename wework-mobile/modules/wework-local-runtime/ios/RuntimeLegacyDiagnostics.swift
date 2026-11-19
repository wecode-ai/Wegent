import Foundation

enum RuntimeLegacyDiagnostics {
  enum Failure: Error { case notRegularFile }

  static func clean(profile: URL, cache: URL) throws {
    try removeRegularFile(profile.appendingPathComponent("events.jsonl"))
    try removeRegularFile(cache.appendingPathComponent("chat-layout-diagnostics.jsonl"))
  }

  private static func removeRegularFile(_ file: URL) throws {
    let attributes: [FileAttributeKey: Any]
    do { attributes = try FileManager.default.attributesOfItem(atPath: file.path) }
    catch let error as NSError where error.domain == NSCocoaErrorDomain &&
      (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) { return }
    guard attributes[.type] as? FileAttributeType == .typeRegular else {
      throw Failure.notRegularFile
    }
    try FileManager.default.removeItem(at: file)
  }
}
