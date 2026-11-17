import Foundation

@main
struct RuntimeImageInstallerTests {
  private static let files = FileManager.default
  private static let oldBinary = Data("old-executor".utf8)
  private static let newBinary = Data("new-executor".utf8)
  private enum Interrupted: Error { case stop }

  static func main() throws {
    try freshInstallAndRepeat()
    try upgradeRetainsData()
    try interruptedReplacementRecovers(afterSwap: false)
    try interruptedReplacementRecovers(afterSwap: true)
    try incompatibleOrUnknownVersionDoesNotTouchData()
    try corruptPayloadDoesNotReplaceExecutor()
    try rejectsModifiedExecutor()
    try rejectsSymbolicLinks()
    print("PASS native image installation: fresh, upgrade, preserved data, interruption, version, integrity, and symlink boundaries")
  }

  private struct Fixture {
    let root: URL
    let resources: URL
    let image: RuntimeImage
    var guest: URL { root.appendingPathComponent("guest") }
    var binary: URL { guest.appendingPathComponent("data/opt/wegent-executor") }
    var stamp: URL { root.appendingPathComponent("runtime-version") }

    func extract(_ archive: URL, _ staging: URL) throws {
      try files.createDirectory(at: staging.appendingPathComponent("data/opt"), withIntermediateDirectories: true)
      try newBinary.write(to: staging.appendingPathComponent("data/opt/wegent-executor"))
    }

    func start(replace: ((URL, URL) throws -> Void)? = nil) throws {
      try RuntimeImageInstaller.prepare(root: root, resources: resources, extract: extract,
        replaceExecutor: replace ?? { _, source in
          // The native integration suite separately verifies the fakefs rename.
          try Data(contentsOf: source).write(to: binary, options: .atomic)
        })
    }

    func existing(base: String? = nil) throws -> Data {
      try files.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
      try oldBinary.write(to: binary)
      let previous = RuntimeImage(rootfsSha256: String(repeating: "a", count: 64),
        baseRootfsSha256: base ?? image.baseRootfsSha256,
        executorSha256: try RuntimeImageInstaller.digest(binary))
      let record = try JSONEncoder().encode(previous)
      try record.write(to: stamp)
      for path in ["root/project/hello.html", "root/.wework-executor/state.sqlite",
                   "root/.wework-codex/auth.json", "other/worktree/.git/index"] {
        let url = guest.appendingPathComponent("data").appendingPathComponent(path)
        try files.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("retained-\(path)".utf8).write(to: url)
      }
      return record
    }

    func assertUserDataRetained() throws {
      for path in ["root/project/hello.html", "root/.wework-executor/state.sqlite",
                   "root/.wework-codex/auth.json", "other/worktree/.git/index"] {
        let url = guest.appendingPathComponent("data").appendingPathComponent(path)
        try check(try Data(contentsOf: url) == Data("retained-\(path)".utf8))
      }
    }
  }

  private static func fixture(_ operation: (Fixture) throws -> Void) throws {
    let temporary = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? files.removeItem(at: temporary) }
    let root = temporary.appendingPathComponent("profile")
    let resources = temporary.appendingPathComponent("bundle")
    try files.createDirectory(at: root, withIntermediateDirectories: true)
    try files.createDirectory(at: resources, withIntermediateDirectories: true)
    let archive = resources.appendingPathComponent("runtime-rootfs.tar.gz")
    let binary = temporary.appendingPathComponent("executor")
    try Data("verified-archive".utf8).write(to: archive)
    try newBinary.write(to: binary)
    let image = RuntimeImage(rootfsSha256: try RuntimeImageInstaller.digest(archive),
      baseRootfsSha256: String(repeating: "b", count: 64),
      executorSha256: try RuntimeImageInstaller.digest(binary))
    try JSONEncoder().encode(image).write(to: resources.appendingPathComponent("manifest.json"))
    try operation(Fixture(root: root, resources: resources, image: image))
  }

  private static func check(_ condition: @autoclosure () throws -> Bool,
                            _ message: String = "Unexpected installation result") rethrows {
    let value = try condition()
    precondition(value, message)
  }

  private static func assertFailure(_ operation: () throws -> Void) {
    do { try operation(); preconditionFailure("Expected installation failure") } catch {}
  }

  private static func freshInstallAndRepeat() throws {
    try fixture { f in
      try f.start { _, _ in preconditionFailure("Fresh installs must not replace an existing executor") }
      let data = try Data(contentsOf: f.binary)
      precondition(data == newBinary)
      try check(try JSONDecoder().decode(RuntimeImage.self, from: Data(contentsOf: f.stamp)) == f.image)
      // Current installations do not need to unpack the archive again.
      try files.removeItem(at: f.resources.appendingPathComponent("runtime-rootfs.tar.gz"))
      let staging = f.root.appendingPathComponent("runtime-install")
      try files.createDirectory(at: staging, withIntermediateDirectories: false)
      try Data("interrupted-staging".utf8).write(to: staging.appendingPathComponent("partial"))
      try f.start { _, _ in preconditionFailure("An up-to-date executor must not be replaced") }
      precondition(!files.fileExists(atPath: staging.path), "A completed or interrupted upgrade must release staging storage")
      // Adopt the old hash-only stamp without blocking an unchanged image.
      try Data(f.image.rootfsSha256.utf8).write(to: f.stamp)
      try f.start()
    }
  }

  private static func upgradeRetainsData() throws {
    try fixture { f in
      _ = try f.existing()
      let before = try files.attributesOfItem(atPath: f.guest.path)[.systemFileNumber] as! NSNumber
      try f.start()
      let after = try files.attributesOfItem(atPath: f.guest.path)[.systemFileNumber] as! NSNumber
      precondition(before == after, "Upgrade must not move or replace the environment")
      try check(try Data(contentsOf: f.binary) == newBinary)
      try f.assertUserDataRetained()
    }
  }

  private static func interruptedReplacementRecovers(afterSwap: Bool) throws {
    try fixture { f in
      let original = try f.existing()
      assertFailure {
        try f.start { _, source in
          if afterSwap { try Data(contentsOf: source).write(to: f.binary, options: .atomic) }
          throw Interrupted.stop
        }
      }
      try check(try Data(contentsOf: f.stamp) == original, "Failed upgrades must not commit the image record")
      try f.assertUserDataRetained()
      try f.start()
      try check(try Data(contentsOf: f.binary) == newBinary)
      try f.assertUserDataRetained()
      precondition(!files.fileExists(atPath: f.root.appendingPathComponent("runtime-install").path))
    }
  }

  private static func incompatibleOrUnknownVersionDoesNotTouchData() throws {
    for stamp in [Data("unknown-image".utf8), Data("b054d3b477f05341a29b266c7b2faa97825b9113f1cdc69592c8a29efce9559e".utf8), Data("{invalid".utf8)] {
      try fixture { f in
        _ = try f.existing()
        try stamp.write(to: f.stamp)
        assertFailure { try f.start { _, _ in preconditionFailure("Unknown/incompatible versions cannot install") } }
        try check(try Data(contentsOf: f.binary) == oldBinary)
        try check(try Data(contentsOf: f.stamp) == stamp)
        try f.assertUserDataRetained()
      }
    }
    try fixture { f in
      _ = try f.existing(base: String(repeating: "c", count: 64))
      assertFailure { try f.start() }
      try check(try Data(contentsOf: f.binary) == oldBinary)
    }
  }

  private static func corruptPayloadDoesNotReplaceExecutor() throws {
    try fixture { f in
      let original = try f.existing()
      try Data("corrupt-archive".utf8).write(to: f.resources.appendingPathComponent("runtime-rootfs.tar.gz"))
      assertFailure { try f.start { _, _ in preconditionFailure("Corrupt payload cannot install") } }
      try check(try Data(contentsOf: f.stamp) == original)
      try check(try Data(contentsOf: f.binary) == oldBinary)
      try f.assertUserDataRetained()
    }
    try fixture { f in
      let original = try f.existing()
      assertFailure {
        try RuntimeImageInstaller.prepare(root: f.root, resources: f.resources, extract: { archive, staged in
          try f.extract(archive, staged)
          try Data("corrupt-executor".utf8).write(to: staged.appendingPathComponent("data/opt/wegent-executor"))
        }, replaceExecutor: { _, _ in preconditionFailure("Corrupt executor cannot install") })
      }
      try check(try Data(contentsOf: f.stamp) == original)
    }
  }

  private static func rejectsModifiedExecutor() throws {
    try fixture { f in
      _ = try f.existing()
      try Data("user-modified".utf8).write(to: f.binary)
      assertFailure { try f.start { _, _ in preconditionFailure("Modified executor cannot be overwritten") } }
      try check(try Data(contentsOf: f.binary) == Data("user-modified".utf8))
      try f.assertUserDataRetained()
    }
  }

  private static func rejectsSymbolicLinks() throws {
    for path in ["guest", "guest/data", "guest/data/opt", "guest/data/opt/wegent-executor", "runtime-version", "runtime-install"] {
      try fixture { f in
        _ = try f.existing()
        let link = f.root.appendingPathComponent(path)
        let outside = f.root.deletingLastPathComponent().appendingPathComponent("outside")
        if path == "runtime-install" {
          try files.createDirectory(at: outside, withIntermediateDirectories: false)
        } else {
          try files.moveItem(at: link, to: outside)
        }
        try files.createSymbolicLink(at: link, withDestinationURL: outside)
        assertFailure { try f.start() }
        try check(try files.destinationOfSymbolicLink(atPath: link.path) == outside.path)
      }
    }
  }
}
