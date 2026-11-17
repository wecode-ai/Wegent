import Foundation

@main
struct RuntimeLegacyDiagnosticsTests {
  static func main() throws {
    let manager = FileManager.default
    let root = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try manager.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? manager.removeItem(at: root) }
    let names = ["events.jsonl", "chat-layout-diagnostics.jsonl", "transcript.jsonl", "auth.json"]
    for name in names { try Data("keep".utf8).write(to: root.appendingPathComponent(name)) }
    try RuntimeLegacyDiagnostics.clean(profile: root, cache: root)
    try RuntimeLegacyDiagnostics.clean(profile: root, cache: root)
    for name in names.suffix(2) {
      let content = try Data(contentsOf: root.appendingPathComponent(name))
      precondition(content == Data("keep".utf8))
    }
    for name in names.prefix(2) { precondition(!manager.fileExists(atPath: root.appendingPathComponent(name).path)) }
    try manager.createSymbolicLink(at: root.appendingPathComponent("events.jsonl"),
      withDestinationURL: root.appendingPathComponent("auth.json"))
    do {
      try RuntimeLegacyDiagnostics.clean(profile: root, cache: root)
      preconditionFailure("Must not follow a diagnostic symlink")
    } catch RuntimeLegacyDiagnostics.Failure.notRegularFile {}
    precondition(manager.fileExists(atPath: root.appendingPathComponent("auth.json").path))
    print("PASS obsolete diagnostics cleanup preserves user files and rejects symlinks")
  }
}
