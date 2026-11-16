import Foundation

@main
struct RuntimeProfilesTests {
  private static let files = FileManager.default
  private static let firstScope = String(repeating: "a", count: 64)
  private static let secondScope = String(repeating: "b", count: 64)
  private static let thirdScope = String(repeating: "c", count: 64)

  static func main() throws {
    try missingDirectoriesRemainMissing()
    try listsOnlyCompleteEnvironmentsWithoutReadingContents()
    try ordersByModificationTimeThenScopeInMilliseconds()
    try rejectsSymbolicLinks()
    try propagatesReadErrors()
    print("PASS native profile enumeration: completeness, strict scope, read-only metadata, ordering, milliseconds, symlinks, and read errors")
  }

  private static func withTemporaryDirectory(_ operation: (URL) throws -> Void) throws {
    let directory = files.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try files.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? files.removeItem(at: directory) }
    try operation(directory)
  }

  private static func makeProfile(_ root: URL, scope: String,
                                  guest: Bool = true, stamp: Bool = true) throws -> URL {
    let profile = RuntimeProfiles.accountsDirectory(in: root).appendingPathComponent(scope)
    try files.createDirectory(at: profile, withIntermediateDirectories: true)
    if guest {
      try files.createDirectory(at: profile.appendingPathComponent("guest"), withIntermediateDirectories: false)
    }
    if stamp { try Data().write(to: profile.appendingPathComponent("runtime-version")) }
    return profile
  }

  private static func missingDirectoriesRemainMissing() throws {
    try withTemporaryDirectory { root in
      let missingRuntime = try RuntimeProfiles.list(in: root)
      let rootEntries = try files.contentsOfDirectory(atPath: root.path)
      precondition(missingRuntime.isEmpty && rootEntries.isEmpty)
      let runtime = RuntimeProfiles.accountsDirectory(in: root).deletingLastPathComponent()
      try files.createDirectory(at: runtime, withIntermediateDirectories: false)
      let missingAccounts = try RuntimeProfiles.list(in: root)
      let runtimeEntries = try files.contentsOfDirectory(atPath: runtime.path)
      precondition(missingAccounts.isEmpty && runtimeEntries.isEmpty)
    }
  }

  private static func listsOnlyCompleteEnvironmentsWithoutReadingContents() throws {
    try withTemporaryDirectory { root in
      let valid = try makeProfile(root, scope: firstScope)
      _ = try makeProfile(root, scope: secondScope, guest: false)
      _ = try makeProfile(root, scope: thirdScope, stamp: false)
      for scope in [String(firstScope.dropLast()), firstScope + "a", firstScope + "\n",
                    String(repeating: "F", count: 64), String(repeating: "g", count: 64), "legacy"] {
        _ = try makeProfile(root, scope: scope)
      }
      let wrongGuest = try makeProfile(root, scope: String(repeating: "d", count: 64), guest: false)
      try Data().write(to: wrongGuest.appendingPathComponent("guest"))
      let wrongStamp = try makeProfile(root, scope: String(repeating: "e", count: 64), stamp: false)
      try files.createDirectory(at: wrongStamp.appendingPathComponent("runtime-version"),
        withIntermediateDirectories: false)
      let guest = valid.appendingPathComponent("guest")
      let stamp = valid.appendingPathComponent("runtime-version")
      try Data("private-content".utf8).write(to: guest.appendingPathComponent("private"))
      let before = try files.attributesOfItem(atPath: valid.path)[.modificationDate] as! Date
      try files.setAttributes([.posixPermissions: 0o000], ofItemAtPath: guest.path)
      try files.setAttributes([.posixPermissions: 0o000], ofItemAtPath: stamp.path)
      defer {
        try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: guest.path)
        try? files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: stamp.path)
      }
      let profiles = try RuntimeProfiles.list(in: root)
      precondition(profiles.map(\.accountScope) == [firstScope])
      let after = try files.attributesOfItem(atPath: valid.path)[.modificationDate] as! Date
      precondition(before == after, "Listing must not modify an existing environment")
    }
  }

  private static func ordersByModificationTimeThenScopeInMilliseconds() throws {
    try withTemporaryDirectory { root in
      let older = Date(timeIntervalSince1970: 1_700_000_000.125)
      let newer = Date(timeIntervalSince1970: 1_700_000_100.75)
      for (scope, date) in [(thirdScope, older), (secondScope, newer), (firstScope, newer)] {
        let profile = try makeProfile(root, scope: scope)
        try files.setAttributes([.modificationDate: date], ofItemAtPath: profile.path)
      }
      let profiles = try RuntimeProfiles.list(in: root)
      precondition(profiles.map(\.accountScope) == [firstScope, secondScope, thirdScope])
      precondition(abs(profiles[0].modifiedAt - 1_700_000_100_750) < 1)
      precondition(abs(profiles[2].modifiedAt - 1_700_000_000_125) < 1)
      let repeated = try RuntimeProfiles.list(in: root)
      precondition(repeated == profiles)
    }
  }

  private static func rejectsSymbolicLinks() throws {
    for component in ["WeworkLocalRuntime", "WeworkLocalRuntime/accounts",
                      "WeworkLocalRuntime/accounts/\(firstScope)",
                      "WeworkLocalRuntime/accounts/\(firstScope)/guest",
                      "WeworkLocalRuntime/accounts/\(firstScope)/runtime-version"] {
      for broken in [false, true] {
        try withTemporaryDirectory { root in
          let support = root.appendingPathComponent("support")
          _ = try makeProfile(support, scope: firstScope)
          let path = support.appendingPathComponent(component)
          let outside = root.appendingPathComponent("outside")
          try files.moveItem(at: path, to: outside)
          if broken { try files.removeItem(at: outside) }
          try files.createSymbolicLink(at: path, withDestinationURL: outside)
          do {
            _ = try RuntimeProfiles.list(in: support)
            preconditionFailure("Symbolic links must never escape profile ownership")
          } catch RuntimeProfiles.Failure.symbolicLink {}
        }
      }
    }
  }

  private static func propagatesReadErrors() throws {
    try withTemporaryDirectory { root in
      _ = try makeProfile(root, scope: firstScope)
      let accounts = RuntimeProfiles.accountsDirectory(in: root)
      try files.setAttributes([.posixPermissions: 0o000], ofItemAtPath: accounts.path)
      defer { try? files.setAttributes([.posixPermissions: 0o700], ofItemAtPath: accounts.path) }
      do {
        _ = try RuntimeProfiles.list(in: root)
        preconditionFailure("Permission failure must not be presented as an empty profile list")
      } catch let error as NSError {
        precondition(error.domain == NSCocoaErrorDomain && error.code == NSFileReadNoPermissionError)
      }
    }
    try withTemporaryDirectory { root in
      let runtime = RuntimeProfiles.accountsDirectory(in: root).deletingLastPathComponent()
      try Data().write(to: runtime)
      do {
        _ = try RuntimeProfiles.list(in: root)
        preconditionFailure("Invalid parent directory must be reported")
      } catch RuntimeProfiles.Failure.notDirectory {}
    }
  }
}
