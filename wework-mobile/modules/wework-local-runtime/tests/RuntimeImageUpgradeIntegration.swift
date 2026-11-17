import Foundation

@main
struct RuntimeImageUpgradeIntegration {
  private static let files = FileManager.default

  static func main() throws {
    precondition(CommandLine.arguments.count == 4)
    let previous = URL(fileURLWithPath: CommandLine.arguments[1])
    let resources = URL(fileURLWithPath: CommandLine.arguments[2])
    let root = URL(fileURLWithPath: CommandLine.arguments[3])
    try files.createDirectory(at: root, withIntermediateDirectories: true)
    let oldImage = try JSONDecoder().decode(RuntimeImage.self,
      from: Data(contentsOf: previous.appendingPathComponent("manifest.json")))
    let guest = root.appendingPathComponent("guest")
    try extract(previous.appendingPathComponent("runtime-rootfs.tar.gz"), guest)
    let stamp = root.appendingPathComponent("runtime-version")
    try Data(oldImage.rootfsSha256.utf8).write(to: stamp)
    try assertHealthy(guest: guest)
    let synthetic = root.appendingPathComponent("synthetic-user-file")
    try Data("user-project-and-auth-preservation".utf8).write(to: synthetic)
    for destination in ["/root/upgrade-project.txt", "/tmp/upgrade-outside-home.txt"] {
      let result = synthetic.path.withCString { source in
        destination.withCString { ww_runtime_import(source, $0) }
      }
      precondition(result == 0)
    }
    let snapshot = try userSnapshot(guest)
    let identity = try files.attributesOfItem(atPath: guest.path)[.systemFileNumber] as! NSNumber
    try prepare(root: root, resources: resources)
    let upgraded = try userSnapshot(guest)
    precondition(snapshot == upgraded, "Existing executor state and user files must survive byte for byte")
    let newIdentity = try files.attributesOfItem(atPath: guest.path)[.systemFileNumber] as! NSNumber
    precondition(identity == newIdentity, "Upgrade must preserve the original guest root")
    try assertHealthy(guest: guest)
    try prepare(root: root, resources: resources)
    try assertHealthy(guest: guest)
    print("PASS delivered image upgrade: legacy stamp, actual fakefs, unchanged user data, executor.ready, health, and restart")
  }

  private static func extract(_ archive: URL, _ guest: URL) throws {
    let result = archive.path.withCString { source in guest.path.withCString { ww_runtime_prepare(source, $0) } }
    precondition(result == 0)
  }

  private static func prepare(root: URL, resources: URL) throws {
    try RuntimeImageInstaller.prepare(root: root, resources: resources, extract: extract) { data, binary in
      let result = data.path.withCString { target in
        binary.path.withCString { ww_runtime_replace_executor(target, $0) }
      }
      precondition(result == 0, "Actual native executor replacement failed")
    }
  }

  private static func userSnapshot(_ guest: URL) throws -> [String: String] {
    var hashes: [String: String] = [:]
    for name in ["root", "tmp"] {
      let directory = guest.appendingPathComponent("data/\(name)")
      let enumerator = files.enumerator(at: directory, includingPropertiesForKeys: [.isRegularFileKey])!
      for case let url as URL in enumerator {
        if try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true {
          hashes[name + "/" + url.path.dropFirst(directory.path.count + 1)] = try RuntimeImageInstaller.digest(url)
        }
      }
    }
    precondition(hashes.count > 2, "The fixture must include actual executor state, not just synthetic files")
    return hashes
  }

  private static func assertHealthy(guest: URL) throws {
    var process: OpaquePointer?
    let result = guest.appendingPathComponent("data").path.withCString { data in
      ww_runtime_start(data, "mobile-local:upgrade-integration", &process)
    }
    precondition(result == 0 && process != nil)
    let executor = process!
    let input = FileHandle(fileDescriptor: ww_runtime_input(executor), closeOnDealloc: true)
    let output = FileHandle(fileDescriptor: ww_runtime_output(executor), closeOnDealloc: true)
    let error = FileHandle(fileDescriptor: ww_runtime_error(executor), closeOnDealloc: true)
    let errorDrain = DispatchGroup()
    errorDrain.enter()
    DispatchQueue.global().async { _ = try? error.readToEnd(); errorDrain.leave() }
    var ready = false
    var healthy = false
    try RuntimePipeReader.readLines(from: output.fileDescriptor) { line in
      let frame = try JSONSerialization.jsonObject(with: line) as! [String: Any]
      if frame["event"] as? String == "executor.ready" {
        ready = true
        try input.write(contentsOf: Data("{\"type\":\"request\",\"id\":\"health\",\"method\":\"executor.health\",\"params\":{}}\n".utf8))
      }
      if frame["id"] as? String == "health" {
        precondition(frame["ok"] as? Bool == true && (frame["result"] as? [String: Any])?["status"] as? String == "healthy", "Health RPC must succeed after migration")
        healthy = true
        precondition(ww_runtime_stop() == 0)
      }
    }
    var status: Int32 = 0
    precondition(ww_runtime_wait(executor, &status) == 0)
    ww_runtime_release(executor)
    try input.close(); try output.close()
    errorDrain.wait(); try error.close()
    precondition(ready && healthy)
  }
}
