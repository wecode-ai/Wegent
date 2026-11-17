import CryptoKit
import Foundation

struct RuntimeImage: Codable, Equatable {
  let rootfsSha256: String
  let baseRootfsSha256: String
  let executorSha256: String

  func validate() throws {
    for hash in [rootfsSha256, baseRootfsSha256, executorSha256] {
      guard hash.utf8.count == 64,
            hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw RuntimeImageInstaller.Failure.invalidManifest
      }
    }
  }
}

enum RuntimeImageInstaller {
  enum Failure: LocalizedError {
    case invalidManifest, unknownVersion, incompatibleBase, invalidPath, integrity, modifiedExecutor

    var errorDescription: String? {
      switch self {
      case .invalidManifest: return "本机资源清单无效"
      case .unknownVersion: return "无法识别现有本机环境版本，数据已保留"
      case .incompatibleBase: return "本机系统环境需要升级，现有数据已保留"
      case .invalidPath: return "本机环境文件结构异常，数据已保留"
      case .integrity: return "本机程序校验失败，现有数据已保留"
      case .modifiedExecutor: return "本机执行程序已被修改，无法安全升级，数据已保留"
      }
    }
  }

  // Releases before the image record stored only the archive hash. These two
  // delivered archives differ only in /opt/wegent-executor; their base is identical.
  private static let legacyImages = [
    RuntimeImage(
      rootfsSha256: "b054d3b477f05341a29b266c7b2faa97825b9113f1cdc69592c8a29efce9559e",
      baseRootfsSha256: "2b21b2bdd2264d4e008f8dd69f4c52c3b4df79441ec697e5c26b0ef0569b2a27",
      executorSha256: "5b3eb03c8b91d61b9b14866c2fba292f47e8f15d2bf83fd93e5fbde2cceecffd"),
    RuntimeImage(
      rootfsSha256: "ee622c163fb6c3cffd5863f79bf97d9d15a91ffd6d0932eaecbb278171cc1e9a",
      baseRootfsSha256: "2b21b2bdd2264d4e008f8dd69f4c52c3b4df79441ec697e5c26b0ef0569b2a27",
      executorSha256: "cb32a818f38e55d58435961e5ad474a6356a7d4c6351abdc5051ab61219aa4f1")
  ]

  static func prepare(root: URL, resources: URL,
                      extract: (URL, URL) throws -> Void,
                      replaceExecutor: (URL, URL) throws -> Void) throws {
    let image = try JSONDecoder().decode(RuntimeImage.self,
      from: Data(contentsOf: resources.appendingPathComponent("manifest.json")))
    try image.validate()
    try requireType(root, .typeDirectory)
    try discardStaging(in: root)
    let guest = root.appendingPathComponent("guest")
    let stamp = root.appendingPathComponent("runtime-version")
    let guestType = try type(guest)
    if guestType == nil {
      try install(root: root, resources: resources, image: image, stamp: stamp, extract: extract)
      return
    }
    guard guestType == .typeDirectory else { throw Failure.invalidPath }
    let installed = try readImage(stamp, current: image)
    guard installed.baseRootfsSha256 == image.baseRootfsSha256 else {
      throw Failure.incompatibleBase
    }
    let executor = try executorURL(in: guest)
    let actual = try digest(executor)
    guard actual == installed.executorSha256 || actual == image.executorSha256 else {
      throw Failure.modifiedExecutor
    }
    if installed == image, (try Data(contentsOf: stamp)).first == UInt8(ascii: "{") { return }
    if actual != image.executorSha256 {
      try withExtractedImage(root: root, resources: resources, image: image, extract: extract) { staged in
        try replaceExecutor(guest.appendingPathComponent("data"), try executorURL(in: staged))
      }
      guard try digest(executor) == image.executorSha256 else { throw Failure.integrity }
    }
    // A single atomic record commits the image only after the guest replacement.
    // If interrupted between those steps, the next attempt accepts the new binary.
    try save(image, to: stamp)
  }

  private static func install(root: URL, resources: URL, image: RuntimeImage, stamp: URL,
                              extract: (URL, URL) throws -> Void) throws {
    if try type(stamp) != nil { try requireType(stamp, .typeRegular) }
    try withExtractedImage(root: root, resources: resources, image: image, extract: extract) { staged in
      // Publish the stamp first: interruption before the rename leaves no guest
      // data to replace, so a subsequent start can finish the fresh installation.
      try save(image, to: stamp)
      try FileManager.default.moveItem(at: staged, to: root.appendingPathComponent("guest"))
    }
  }

  private static func withExtractedImage(root: URL, resources: URL, image: RuntimeImage,
                                          extract: (URL, URL) throws -> Void,
                                          operation: (URL) throws -> Void) throws {
    let archive = resources.appendingPathComponent("runtime-rootfs.tar.gz")
    try requireType(archive, .typeRegular)
    guard try digest(archive) == image.rootfsSha256 else { throw Failure.integrity }
    // This host-owned staging directory is outside guest/data and never holds user files.
    let staging = root.appendingPathComponent("runtime-install")
    defer { try? FileManager.default.removeItem(at: staging) }
    try extract(archive, staging)
    guard try digest(executorURL(in: staging)) == image.executorSha256 else { throw Failure.integrity }
    #if os(iOS)
    try FileManager.default.setAttributes(
      [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: staging.path)
    #endif
    try operation(staging)
  }

  private static func discardStaging(in root: URL) throws {
    let staging = root.appendingPathComponent("runtime-install")
    if try type(staging) != nil {
      try requireType(staging, .typeDirectory)
      try FileManager.default.removeItem(at: staging)
    }
  }

  private static func readImage(_ stamp: URL, current: RuntimeImage) throws -> RuntimeImage {
    try requireType(stamp, .typeRegular)
    let data = try Data(contentsOf: stamp)
    if data.first == UInt8(ascii: "{") {
      let image = try JSONDecoder().decode(RuntimeImage.self, from: data)
      try image.validate()
      return image
    }
    let hash = String(data: data, encoding: .utf8)
    if hash == current.rootfsSha256 { return current }
    guard let image = legacyImages.first(where: { $0.rootfsSha256 == hash }) else {
      throw Failure.unknownVersion
    }
    return image
  }

  private static func save(_ image: RuntimeImage, to stamp: URL) throws {
    if try type(stamp) != nil { try requireType(stamp, .typeRegular) }
    #if os(iOS)
    let options: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    #else
    let options: Data.WritingOptions = [.atomic]
    #endif
    try JSONEncoder().encode(image).write(to: stamp, options: options)
  }

  private static func executorURL(in guest: URL) throws -> URL {
    for path in ["", "data", "data/opt"] {
      try requireType(guest.appendingPathComponent(path), .typeDirectory)
    }
    let binary = guest.appendingPathComponent("data/opt/wegent-executor")
    try requireType(binary, .typeRegular)
    return binary
  }

  private static func type(_ url: URL) throws -> FileAttributeType? {
    do { return try FileManager.default.attributesOfItem(atPath: url.path)[.type] as? FileAttributeType }
    catch let error as NSError where error.domain == NSCocoaErrorDomain &&
      (error.code == NSFileNoSuchFileError || error.code == NSFileReadNoSuchFileError) { return nil }
  }

  private static func requireType(_ url: URL, _ expected: FileAttributeType) throws {
    guard try type(url) == expected else { throw Failure.invalidPath }
  }

  static func digest(_ url: URL) throws -> String {
    let file = try FileHandle(forReadingFrom: url)
    defer { try? file.close() }
    var hash = SHA256()
    while let chunk = try file.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
    return hash.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
