import Foundation

struct RuntimeProfile: Equatable {
  let accountScope: String
  let modifiedAt: Double
}

enum RuntimeProfiles {
  enum Failure: Error {
    case symbolicLink
    case notDirectory
    case missingModificationDate
  }

  static func accountsDirectory(in applicationSupport: URL) -> URL {
    applicationSupport.appendingPathComponent("WeworkLocalRuntime/accounts", isDirectory: true)
  }

  static func applicationSupport(create: Bool) throws -> URL {
    try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
      appropriateFor: nil, create: create)
  }

  static func list(in applicationSupport: URL) throws -> [RuntimeProfile] {
    let accounts = accountsDirectory(in: applicationSupport)
    guard try existingDirectory(accounts.deletingLastPathComponent()),
          try existingDirectory(accounts) else { return [] }
    let entries = try FileManager.default.contentsOfDirectory(at: accounts,
      includingPropertiesForKeys: nil, options: [])
    var profiles: [RuntimeProfile] = []
    for entry in entries {
      let scope = entry.lastPathComponent
      guard scope.utf8.count == 64,
            scope.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { continue }
      let attributes = try checkedAttributes(at: entry)
      guard attributes?[.type] as? FileAttributeType == .typeDirectory,
            try checkedAttributes(at: entry.appendingPathComponent("guest"))?[.type]
              as? FileAttributeType == .typeDirectory,
            try checkedAttributes(at: entry.appendingPathComponent("runtime-version"))?[.type]
              as? FileAttributeType == .typeRegular else { continue }
      guard let modified = attributes?[.modificationDate] as? Date else {
        throw Failure.missingModificationDate
      }
      profiles.append(RuntimeProfile(accountScope: scope,
        modifiedAt: modified.timeIntervalSince1970 * 1000))
    }
    return profiles.sorted {
      $0.modifiedAt == $1.modifiedAt ? $0.accountScope < $1.accountScope : $0.modifiedAt > $1.modifiedAt
    }
  }

  private static func existingDirectory(_ directory: URL) throws -> Bool {
    guard let attributes = try checkedAttributes(at: directory) else { return false }
    guard attributes[.type] as? FileAttributeType == .typeDirectory else {
      throw Failure.notDirectory
    }
    return true
  }

  private static func checkedAttributes(at url: URL) throws -> [FileAttributeKey: Any]? {
    let attributes: [FileAttributeKey: Any]
    do { attributes = try FileManager.default.attributesOfItem(atPath: url.path) }
    catch let error as NSError where error.domain == NSCocoaErrorDomain &&
      (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) {
      return nil
    }
    guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else {
      throw Failure.symbolicLink
    }
    return attributes
  }
}
