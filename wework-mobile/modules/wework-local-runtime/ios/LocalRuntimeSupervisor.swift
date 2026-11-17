import ExpoModulesCore
import Foundation
import Network
import OSLog
import UIKit

private final class RuntimeNativeException: Exception, @unchecked Sendable {
  private let summary: String
  override var reason: String { summary }

  init(_ failure: RuntimeFailure) {
    summary = failure.message
    super.init(name: failure.code, description: failure.message, code: failure.code)
  }
}

struct RuntimeFailure: Error {
  let code: String
  let message: String
  let details: [String: Any]
  init(_ code: String, _ message: String, details: [String: Any] = [:]) {
    self.code = code; self.message = message; self.details = details
  }
  func reject(_ promise: Promise) {
    let exception = RuntimeNativeException(self)
    exception.cause = NSError(domain: "WeworkLocalRuntime", code: 1,
      userInfo: details.merging([NSLocalizedDescriptionKey: message]) { _, new in new })
    promise.reject(exception)
  }
}

final class LocalRuntimeSupervisor {
  private struct PendingRequest {
    let method: String
    let rawResponse: Bool
    let completion: (Result<Any, RuntimeFailure>) -> Void
  }
  static let shared = LocalRuntimeSupervisor()
  private let queue = DispatchQueue(label: "io.wecode.wework.local.state")
  private let lifecycle = DispatchQueue(label: "io.wecode.wework.local.lifecycle", qos: .userInitiated)
  private let writer = DispatchQueue(label: "io.wecode.wework.local.writer")
  private let logger = Logger(subsystem: "io.wecode.wework", category: "LocalRuntime")
  private let journal = RuntimeEventJournal()
  private let background = RuntimeBackgroundWork()
  private let network = NWPathMonitor()
  private var foregroundObserver: NSObjectProtocol?
  private var listeners: [UUID: (String, [String: Any]) -> Void] = [:]
  private var state = "stopped"
  private var scope: String?
  private var deviceId: String?
  private var generation = 0
  private var backgroundState = "notRequested"
  private var failure: String?
  private var process: OpaquePointer?
  private var completedWaiters: Set<OpaquePointer> = []
  private var releaseAfterWait: Set<OpaquePointer> = []
  private var input: FileHandle?
  private var startup: Promise?
  private var pending: [String: PendingRequest] = [:]
  private var workRequests: [String: String] = [:]
  private let workLeases = RuntimeWorkLeaseRevisions()

  private var resources: URL? {
    Bundle.main.url(forResource: "WeworkLocalRuntimeResources", withExtension: "bundle")
  }
  private var supported: Bool { ww_runtime_available() != 0 && resources != nil }

  private init() {
    ww_runtime_set_diagnostics_enabled(RuntimeDiagnostics.shared.isEnabled ? 1 : 0)
    network.pathUpdateHandler = { [weak self] _ in self?.refreshDNS() }
    network.start(queue: DispatchQueue(label: "io.wecode.wework.local.network"))
    foregroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.refreshDNS() }
    background.changed = { [weak self] value, generation in
      self?.queue.async {
        guard let self, self.generation == generation else { return }
        self.backgroundState = value; self.publishStatus()
      }
    }
    background.expired = { [weak self] taskId, generation in
      self?.queue.async {
        guard let self, self.generation == generation, self.state == "running" else { return }
        self.rpc("runtime.tasks.cancel", params: ["taskId": taskId], timeout: 15000) { result in
          guard self.generation == generation else { return }
          if case .success(let value) = result, let response = value as? [String: Any],
             response["success"] as? Bool == true, response["cleanupPending"] as? Bool != true {
            return
          }
          self.failure = "后台任务已过期，任务未确认结束，正在停止本机执行环境"
          self.publishStatus()
          self.stop(nil)
        }
      }
    }
  }

  private func refreshDNS() {
    queue.async {
      guard self.state == "running" else { return }
      self.logTransportDiagnostics("network-or-foreground")
      let generation = self.generation
      self.lifecycle.async {
        let result = ww_runtime_refresh_dns()
        self.queue.async {
          guard generation == self.generation && self.state == "running" else { return }
          if result != 0 {
            self.failure = "系统 DNS 同步失败（\(result)）"
            self.publishStatus()
          }
        }
      }
    }
  }

  private func logTransportDiagnostics(_ trigger: String) {
    guard RuntimeDiagnostics.shared.isEnabled else { return }
    let value = ww_runtime_transport_diagnostics(process)
    if RuntimeDiagnostics.shared.isEnabled { logger.notice("IPC diagnostics trigger=\(trigger, privacy: .public) generation=\(self.generation, privacy: .public) accepts=\(value.accept_calls, privacy: .public) acceptFailures=\(value.accept_failures, privacy: .public) hostErrno=\(value.accept_host_error, privacy: .public) guestPid=\(value.accepting_pid, privacy: .public) listenersRestored=\(value.listeners_restored, privacy: .public) listenerFailures=\(value.listener_failures, privacy: .public) listenerErrno=\(value.listener_host_error, privacy: .public) inputBytes=\(value.input_bytes, privacy: .public) outputBytes=\(value.output_bytes, privacy: .public)") }
  }

  func subscribe(_ listener: @escaping (String, [String: Any]) -> Void) -> UUID {
    let id = UUID()
    queue.async { self.listeners[id] = listener }
    return id
  }
  func unsubscribe(_ id: UUID) { queue.async { self.listeners.removeValue(forKey: id) } }
  func status(_ promise: Promise) { queue.async { promise.resolve(self.snapshot()) } }
  func listProfiles(_ promise: Promise) {
    lifecycle.async {
      do {
        let profiles = try RuntimeProfiles.list(in: RuntimeProfiles.applicationSupport(create: false))
        promise.resolve(profiles.map { profile -> [String: Any] in
          ["accountScope": profile.accountScope, "modifiedAt": profile.modifiedAt]
        })
      } catch {
        RuntimeFailure("runtime_profiles", "本机环境列表读取失败",
          details: ["cause": error.localizedDescription]).reject(promise)
      }
    }
  }
  func events(_ options: [String: Any], promise: Promise) {
    queue.async {
      guard self.checkScope(options, promise: promise) else { return }
      do {
        let cursor = try RuntimeBridgeOptions.integer(options["afterSequence"], default: 0, minimum: 0)
        promise.resolve(self.journal.read(after: cursor))
      } catch {
        RuntimeFailure("invalid_request", "事件读取位置必须是非负整数").reject(promise)
      }
    }
  }
  private func checkScope(_ options: [String: Any], promise: Promise) -> Bool {
    guard options["accountScope"] as? String == scope, scope != nil else {
      RuntimeFailure("account_changed", "本机执行器所属账号已变化").reject(promise)
      return false
    }
    return true
  }

  private func snapshot() -> [String: Any] {
    var value: [String: Any] = ["supported": supported, "state": state, "generation": generation,
      "background": supported ? backgroundState : "unavailable"]
    if let scope { value["accountScope"] = scope }
    if let deviceId { value["deviceId"] = deviceId }
    if let failure { value["error"] = failure }
    else if !supported { value["error"] = "此安装包未包含本机执行组件" }
    return value
  }
  private func publishStatus() {
    if RuntimeDiagnostics.shared.isEnabled { logger.notice("Runtime status state=\(self.state, privacy: .public) generation=\(self.generation, privacy: .public) background=\(self.backgroundState, privacy: .public) pending=\(self.pending.count, privacy: .public) sequence=\(self.journal.sequence, privacy: .public)") }
    emit("onRuntimeStatus", snapshot())
  }
  private func emit(_ name: String, _ body: [String: Any]) {
    for listener in listeners.values { listener(name, body) }
  }

  func start(_ options: [String: Any], promise: Promise) {
    queue.async {
      guard self.supported else {
        RuntimeFailure("runtime_unavailable", "此安装包未包含本机执行组件").reject(promise); return
      }
      guard let scope = options["accountScope"] as? String,
            scope.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        RuntimeFailure("invalid_scope", "账号标识无效").reject(promise); return
      }
      if self.state == "running" && self.scope == scope { promise.resolve(self.snapshot()); return }
      guard self.state == "stopped" && self.process == nil else {
        RuntimeFailure("runtime_busy", "请先停止当前本机执行环境").reject(promise); return
      }
      self.journal.reset()
      self.scope = scope
      let defaults = UserDefaults.standard
      let installation = defaults.string(forKey: "wework.local.installation") ?? UUID().uuidString.lowercased()
      defaults.set(installation, forKey: "wework.local.installation")
      self.deviceId = "mobile-local:\(installation):\(scope)"
      self.generation = defaults.integer(forKey: "wework.local.generation") + 1
      defaults.set(self.generation, forKey: "wework.local.generation")
      let generation = self.generation
      let device = self.deviceId!
      if RuntimeDiagnostics.shared.isEnabled { self.logger.info("Startup requested generation=\(generation, privacy: .public)") }
      self.state = "starting"; self.failure = nil; self.startup = promise
      self.backgroundState = "notRequested"; self.publishStatus()
      self.lifecycle.async {
        do {
          let directory = try self.prepare(scope: scope)
          if RuntimeDiagnostics.shared.isEnabled { self.logger.info("Runtime resources prepared generation=\(generation, privacy: .public)") }
          var process: OpaquePointer?
          let result = directory.appendingPathComponent("guest/data").path.withCString { data in
            device.withCString { ww_runtime_start(data, $0, &process) }
          }
          if RuntimeDiagnostics.shared.isEnabled { self.logger.info("Runtime launch returned generation=\(generation, privacy: .public) code=\(result, privacy: .public)") }
          guard result == 0, let process else {
            if let process {
              self.disposeUnclaimed(process, generation: generation)
            }
            throw RuntimeFailure("runtime_start", "执行环境启动失败（\(result)）")
          }
          self.queue.async {
            guard generation == self.generation, self.state == "starting" else {
              self.lifecycle.async {
                self.disposeUnclaimed(process, generation: generation)
              }
              return
            }
            self.process = process
            self.input = FileHandle(fileDescriptor: ww_runtime_input(process), closeOnDealloc: true)
            self.readOutput(process, generation: generation)
            self.queue.asyncAfter(deadline: .now() + 45) {
              if self.state == "starting" && generation == self.generation {
                self.failed("执行器启动超时"); self.stop(nil)
              }
            }
          }
        } catch {
          let failure = (error as? RuntimeFailure) ?? RuntimeFailure("runtime_prepare", error.localizedDescription)
          self.queue.async {
            self.failed(failure.message, startupFailure: failure)
          }
        }
      }
    }
  }

  private func disposeUnclaimed(_ process: OpaquePointer, generation: Int) {
    dispatchPrecondition(condition: .onQueue(lifecycle))
    close(ww_runtime_input(process)); close(ww_runtime_output(process)); close(ww_runtime_error(process))
    let stopped = ww_runtime_stop()
    if stopped == 0 {
      var status: Int32 = 0
      _ = ww_runtime_wait(process, &status)
      ww_runtime_release(process)
    } else {
      queue.async {
        self.process = process
        self.observeExit(process, generation: generation)
        self.failed("取消启动时线程未完全结束（\(stopped)）")
      }
    }
  }

  private func prepare(scope: String) throws -> URL {
    guard let resources else { throw RuntimeFailure("runtime_unavailable", "本机资源缺失") }
    let root = try RuntimeProfiles.accountsDirectory(in: RuntimeProfiles.applicationSupport(create: true))
      .appendingPathComponent(scope, isDirectory: true)
    let attributes: [FileAttributeKey: Any] = [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: attributes)
    do {
      let cache = try FileManager.default.url(for: .cachesDirectory, in: .userDomainMask,
        appropriateFor: nil, create: false)
      try RuntimeLegacyDiagnostics.clean(profile: root, cache: cache)
    } catch {
      if RuntimeDiagnostics.shared.isEnabled { logger.error("Obsolete diagnostic cleanup failed") }
    }
    try RuntimeImageInstaller.prepare(root: root, resources: resources, extract: { archive, staging in
      let result = archive.path.withCString { archivePath in
        staging.path.withCString { ww_runtime_prepare(archivePath, $0) }
      }
      guard result == 0 else {
        throw RuntimeFailure("runtime_install", "本机环境解压失败（\(result)）")
      }
    }, replaceExecutor: { data, binary in
      let result = data.path.withCString { dataPath in
        binary.path.withCString { ww_runtime_replace_executor(dataPath, $0) }
      }
      guard result == 0 else {
        throw RuntimeFailure("runtime_upgrade", "本机执行程序升级失败（\(result)），现有数据已保留")
      }
    })
    return root
  }

  private func readOutput(_ process: OpaquePointer, generation: Int) {
    let output = FileHandle(fileDescriptor: ww_runtime_output(process), closeOnDealloc: true)
    let error = FileHandle(fileDescriptor: ww_runtime_error(process), closeOnDealloc: true)
    DispatchQueue.global(qos: .userInitiated).async {
      defer { try? output.close() }
      var frameCount = 0
      var receivedBytes = 0
      if RuntimeDiagnostics.shared.isEnabled { self.logger.info("IPC reader started generation=\(generation, privacy: .public)") }
      do {
        try RuntimePipeReader.readLines(from: output.fileDescriptor) { line in
          frameCount += 1; receivedBytes += line.count
          if frameCount == 1 {
            if RuntimeDiagnostics.shared.isEnabled { self.logger.info("IPC first frame generation=\(generation, privacy: .public) bytes=\(line.count, privacy: .public)") }
          }
          guard let frame = try JSONSerialization.jsonObject(with: line) as? [String: Any] else {
            throw RuntimeFailure("runtime_protocol", "执行器返回无效消息")
          }
          self.queue.async { if generation == self.generation { self.receive(frame) } }
        }
        if RuntimeDiagnostics.shared.isEnabled { self.logger.info("IPC EOF generation=\(generation, privacy: .public) frames=\(frameCount, privacy: .public) bytes=\(receivedBytes, privacy: .public)") }
        self.queue.async {
          if generation == self.generation && ["starting", "running"].contains(self.state) {
            self.failed("执行器通道已关闭"); self.stop(nil)
          }
        }
      } catch {
        let failure = error as NSError
        if RuntimeDiagnostics.shared.isEnabled { self.logger.error("IPC read failed generation=\(generation, privacy: .public) frames=\(frameCount, privacy: .public) domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)") }
        self.queue.async {
          if generation == self.generation && ["starting", "running"].contains(self.state) {
            self.failed("执行器通道中断"); self.stop(nil)
          }
        }
      }
    }
    // Only fixed startup checkpoints cross the diagnostic boundary; fields are discarded.
    DispatchQueue.global(qos: .utility).async {
      defer { try? error.close() }
      var diagnostics: RuntimeStartupDiagnostics?
      do {
        try RuntimePipeReader.readChunks(from: error.fileDescriptor) { chunk in
          guard RuntimeDiagnostics.shared.isEnabled else { diagnostics = nil; return }
          if diagnostics == nil { diagnostics = RuntimeStartupDiagnostics() }
          diagnostics?.consume(chunk) { stage in
            if RuntimeDiagnostics.shared.isEnabled { self.logger.notice("Executor checkpoint generation=\(generation, privacy: .public) stage=\(stage, privacy: .public)") }
          }
        }
      }
      catch {
        let failure = error as NSError
        if RuntimeDiagnostics.shared.isEnabled { self.logger.error("Diagnostic drain failed generation=\(generation, privacy: .public) domain=\(failure.domain, privacy: .public) code=\(failure.code, privacy: .public)") }
      }
    }
    observeExit(process, generation: generation)
  }

  private func observeExit(_ process: OpaquePointer, generation: Int) {
    DispatchQueue.global(qos: .utility).async {
      var status: Int32 = 0
      let result = ww_runtime_wait(process, &status)
      self.queue.async {
        if RuntimeDiagnostics.shared.isEnabled { self.logger.notice("Executor exit generation=\(generation, privacy: .public) result=\(result, privacy: .public) status=\(status, privacy: .public)") }
        if self.releaseAfterWait.remove(process) != nil { ww_runtime_release(process) }
        else { self.completedWaiters.insert(process) }
        guard generation == self.generation else { return }
        if self.state != "stopping" && self.state != "stopped" {
          self.failed("执行器已退出（\(result == 0 ? status : result)）")
          self.stop(nil)
        }
      }
    }
  }

  private func receive(_ frame: [String: Any]) {
    guard state == "starting" || state == "running" else { return }
    if frame["type"] as? String == "response", let id = frame["id"] as? String {
      let workTask = workRequests.removeValue(forKey: id)
      defer { if let workTask { reconcileWork(taskId: workTask) } }
      guard let callback = pending.removeValue(forKey: id) else {
        return
      }
      if callback.method == "runtime.codex.app_server.restart", RuntimeDiagnostics.shared.isEnabled {
        let result = frame["result"] as? [String: Any] ?? [:]
        let succeeded = frame["ok"] as? Bool == true
        let restarted = result["restarted"] as? Bool == true
        logger.notice("Codex restart response generation=\(self.generation, privacy: .public) ok=\(succeeded, privacy: .public) restarted=\(restarted, privacy: .public)")
      }
      if callback.method == "runtime.tasks.transcript", RuntimeDiagnostics.shared.isEnabled {
        let result = frame["result"] as? [String: Any] ?? [:]
        let turns = (result["turns"] as? [Any])?.count ?? -1
        let messages = (result["messages"] as? [Any])?.count ?? -1
        let succeeded = frame["ok"] as? Bool == true
        logger.notice("Transcript response generation=\(self.generation, privacy: .public) ok=\(succeeded, privacy: .public) turns=\(turns, privacy: .public) messages=\(messages, privacy: .public)")
      }
      if callback.rawResponse { callback.completion(.success(frame)); return }
      if frame["ok"] as? Bool == true { callback.completion(.success(frame["result"] ?? NSNull())) }
      else {
        let error = frame["error"] as? [String: Any] ?? [:]
        callback.completion(.failure(RuntimeFailure(error["code"] as? String ?? "runtime_error",
          error["message"] as? String ?? "执行器请求失败", details: error)))
      }
      return
    }
    guard frame["type"] as? String == "event", let name = frame["event"] as? String else { return }
    let payload = frame["payload"] as? [String: Any] ?? [:]
    if name == "executor.ready" {
      guard state == "starting" else { return }
      guard payload["device_id"] as? String == deviceId, payload["ready"] as? Bool == true else {
        failed("执行器设备标识不匹配"); stop(nil); return
      }
      if RuntimeDiagnostics.shared.isEnabled { logger.info("Executor ready generation=\(self.generation, privacy: .public)") }
      state = "running"; publishStatus(); startup?.resolve(snapshot()); startup = nil
    }
    if let taskId = payload["taskId"] as? String {
      let data = payload["data"] as? [String: Any] ?? [:]
      let turnSettled = name == "runtime.turn.updated" && data["status"] as? String == "settled"
      if turnSettled || ["response.completed", "response.failed", "response.incomplete"].contains(name) {
        reconcileWork(taskId: taskId)
      }

    }
    do {
      let entry = try journal.append(frame, generation: generation)
      emit("onRuntimeEvent", entry)
    } catch { failed("本机事件无法编码"); stop(nil) }
  }

  func request(_ options: [String: Any], promise: Promise) {
    queue.async {
      guard self.checkScope(options, promise: promise) else { return }
      guard let method = options["method"] as? String, !method.isEmpty,
            let params = options["params"] as? [String: Any] else {
        RuntimeFailure("invalid_request", "请求格式无效").reject(promise); return
      }
      let answersQuestion = method == "runtime.tasks.send" && params["executionRequest"] == nil &&
        params["requestUserInputResponse"] is [String: Any]
      if ["runtime.tasks.create", "runtime.tasks.send"].contains(method) && !answersQuestion {
        let execution = params["executionRequest"] as? [String: Any]
        guard execution?["runtime_permission_profile"] as? String == ":danger-full-access" else {
          RuntimeFailure("unsupported_sandbox", "手机环境不支持 Linux 受限沙盒，请明确选择 App 沙盒内完整访问").reject(promise)
          return
        }
      }
      let timeout: Int
      do {
        timeout = try RuntimeBridgeOptions.integer(options["timeoutMs"], default: 75000, minimum: 1,
                                                  maximum: Int.max / 1_000_000)
      } catch {
        RuntimeFailure("invalid_request", "请求超时必须是正整数毫秒").reject(promise); return
      }
      let complete: (Result<Any, RuntimeFailure>) -> Void = { result in
        switch result { case .success(let value): promise.resolve(value)
        case .failure(let error): error.reject(promise) }
      }
      if let work = options["userWork"] as? [String: Any] {
        let address = params["address"] as? [String: Any]
        guard let taskId = work["taskId"] as? String, !taskId.isEmpty,
              taskId == (params["taskId"] as? String ?? address?["taskId"] as? String),
              let title = work["title"] as? String else {
          RuntimeFailure("invalid_work", "用户任务标识无效").reject(promise); return
        }
        self.submitUserWork(taskId: taskId, title: title, method: method,
                            params: params, timeout: timeout, completion: complete)
      } else { self.rpc(method, params: params, timeout: timeout, rawResponse: true, completion: complete) }
    }
  }

  private func rpc(_ method: String, params: [String: Any], timeout: Int,
                   rawResponse: Bool = false, workTask: String? = nil,
                   completion: @escaping (Result<Any, RuntimeFailure>) -> Void) {
    guard state == "running", let input else {
      completion(.failure(RuntimeFailure("runtime_offline", "本机执行器未运行"))); return
    }
    let id = UUID().uuidString
    let requestGeneration = generation
    do {
      var data = try JSONSerialization.data(withJSONObject: ["type": "request", "id": id,
        "method": method, "params": params])
      data.append(10)
      pending[id] = PendingRequest(method: method, rawResponse: rawResponse, completion: completion)
      if let workTask { workRequests[id] = workTask }
      if RuntimeDiagnostics.shared.isEnabled { logger.notice("IPC request queued method=\(method, privacy: .public) generation=\(requestGeneration, privacy: .public) pending=\(self.pending.count, privacy: .public)") }
      writer.async {
        do {
          try input.write(contentsOf: data)
          if RuntimeDiagnostics.shared.isEnabled { self.logger.notice("IPC request written method=\(method, privacy: .public) generation=\(requestGeneration, privacy: .public)") }
        }
        catch {
          self.queue.async {
            guard self.generation == requestGeneration else { return }
            self.pending.removeValue(forKey: id)?.completion(.failure(RuntimeFailure("runtime_write", "执行器通道写入失败")))
            if self.state == "running" { self.failed("执行器通道写入失败"); self.stop(nil) }
          }
        }
      }
      queue.asyncAfter(deadline: .now() + .milliseconds(max(1, timeout))) {
        guard let request = self.pending.removeValue(forKey: id) else { return }
        if RuntimeDiagnostics.shared.isEnabled { self.logger.error("IPC request timeout method=\(method, privacy: .public) generation=\(requestGeneration, privacy: .public) state=\(self.state, privacy: .public) sequence=\(self.journal.sequence, privacy: .public) pending=\(self.pending.count, privacy: .public)") }
        self.logTransportDiagnostics("request-timeout")
        request.completion(.failure(RuntimeFailure("runtime_timeout", "执行器请求超时")))
      }
    } catch { completion(.failure(RuntimeFailure("invalid_request", "请求无法序列化"))) }
  }

  private func failed(_ message: String, startupFailure: RuntimeFailure? = nil) {
    if RuntimeDiagnostics.shared.isEnabled { logger.error("Runtime failed previousState=\(self.state, privacy: .public) generation=\(self.generation, privacy: .public) pending=\(self.pending.count, privacy: .public) sequence=\(self.journal.sequence, privacy: .public)") }
    state = "failed"; failure = message
    startup.map { (startupFailure ?? RuntimeFailure("runtime_start", message)).reject($0) }; startup = nil
    let callbacks = pending.values; pending.removeAll()
    workRequests.removeAll()
    for callback in callbacks { callback.completion(.failure(RuntimeFailure("runtime_failed", message))) }
    publishStatus()
  }

  func stop(_ options: [String: Any], promise: Promise) {
    queue.async {
      guard self.checkScope(options, promise: promise) else { return }
      self.stop(promise)
    }
  }

  private func stop(_ promise: Promise?) {
    queue.async {
      if self.state == "stopped" { promise?.resolve(nil); return }
      if self.state == "stopping" {
        promise.map { RuntimeFailure("runtime_stopping", "执行环境正在停止").reject($0) }; return
      }
      let generation = self.generation
      self.workLeases.clear(generation: generation)
      self.state = "stopping"; self.publishStatus()
      DispatchQueue.main.async { self.background.endAll(generation: generation) }
      self.startup.map { RuntimeFailure("runtime_stopped", "启动已取消").reject($0) }; self.startup = nil
      let callbacks = self.pending.values; self.pending.removeAll()
      self.workRequests.removeAll()
      for callback in callbacks { callback.completion(.failure(RuntimeFailure("runtime_stopped", "执行环境已停止"))) }
      let input = self.input; self.input = nil
      self.writer.async { try? input?.close() }
      self.lifecycle.async {
        let result = ww_runtime_stop()
        self.queue.async {
          guard result == 0 else {
            self.failed("执行器线程未完全结束（\(result)），无法切换账号")
            promise.map { RuntimeFailure("runtime_stop", self.failure!).reject($0) }; return
          }
          if let process = self.process {
            if self.completedWaiters.remove(process) != nil { ww_runtime_release(process) }
            else { self.releaseAfterWait.insert(process) }
          }
          self.process = nil; self.state = "stopped"
          self.publishStatus(); promise?.resolve(nil)
        }
      }
    }
  }

  private func submitUserWork(taskId: String, title: String, method: String,
                              params: [String: Any], timeout: Int,
                              completion: @escaping (Result<Any, RuntimeFailure>) -> Void) {
    guard state == "running" else {
      completion(.failure(RuntimeFailure("runtime_offline", "本机执行器未运行"))); return
    }
    let token = workLeases.begin(taskId: taskId, generation: generation)
    DispatchQueue.main.async {
      self.background.begin(taskId: taskId, title: title,
                            generation: token.generation, revision: token.revision)
      self.queue.async {
        guard self.state == "running", self.generation == token.generation,
              self.workLeases.isPrepared(taskId: taskId, token: token) else {
          self.workLeases.finishPreparation(taskId: taskId, token: token)
          DispatchQueue.main.async {
            self.background.end(taskId: taskId,
                                generation: token.generation, revision: token.revision)
          }
          completion(.failure(RuntimeFailure("runtime_changed", "执行环境已切换"))); return
        }
        self.workLeases.finishPreparation(taskId: taskId, token: token)
        self.rpc(method, params: params, timeout: timeout, rawResponse: true, workTask: taskId) { result in
          completion(result)
          // Timeouts retain their in-flight request until the real response.
          // Pre-dispatch failures have no in-flight request and can reconcile.
          if case .failure = result { self.reconcileWork(taskId: taskId) }
        }
      }
    }
  }

  private func reconcileWork(taskId: String) {
    // A JS timeout does not cancel an accepted request. Wait for the actual
    // executor response before interpreting a transient task-not-found result.
    if workLeases.hasPrepared(taskId: taskId) || workRequests.values.contains(taskId) { return }
    guard let token = workLeases.current(taskId: taskId) else { return }
    let generation = token.generation
    let reportFailure: (RuntimeFailure) -> Void = { error in
      guard generation == self.generation && self.workLeases.matches(taskId: taskId, token: token) else { return }
      self.failure = "后台任务状态确认失败：\(error.message)"
      self.publishStatus()
    }
    rpc("runtime.tasks.get", params: ["taskId": taskId], timeout: 15000) { result in
      guard self.workLeases.matches(taskId: taskId, token: token),
            !self.workLeases.hasPrepared(taskId: taskId), !self.workRequests.values.contains(taskId) else {
        return
      }
      switch result {
      case .failure(let error): reportFailure(error)
      case .success(let value):
        guard let response = value as? [String: Any] else {
          reportFailure(RuntimeFailure("task_state_unknown", "暂时无法确认任务状态")); return
        }
        if response["success"] as? Bool == false,
           ["task_not_found", "task_archived"].contains(response["code"] as? String ?? "") {
          self.workLeases.remove(taskId: taskId, matching: token)
          DispatchQueue.main.async { self.background.end(taskId: taskId, generation: generation, revision: token.revision) }
          return
        }
        guard response["success"] as? Bool == true else {
          reportFailure(RuntimeFailure("task_state_unknown", "暂时无法确认任务状态")); return
        }
        let task = response["task"] as? [String: Any]
        let execution = task?["executionState"] as? [String: Any]
        let phase = execution?["phase"] as? String
        let running = task?["running"] as? Bool == true ||
          ["queued", "starting", "running", "continuing", "recovering", "stopping"].contains(phase ?? "")
        if running { return }
        guard task != nil && (phase == "idle" || task?["running"] as? Bool == false) else {
          reportFailure(RuntimeFailure("task_state_unknown", "任务状态尚未收敛")); return
        }
        self.workLeases.remove(taskId: taskId, matching: token)
        DispatchQueue.main.async { self.background.end(taskId: taskId, generation: generation, revision: token.revision) }
      }
    }
  }

  func importFile(_ options: [String: Any], promise: Promise) {
    queue.async {
      guard self.checkScope(options, promise: promise) else { return }
      guard self.state == "running", let uri = options["uri"] as? String,
            let source = URL(string: uri), source.isFileURL,
            let name = options["name"] as? String, !name.isEmpty else {
        RuntimeFailure("invalid_file", "请选择本机文件").reject(promise); return
      }
      let generation = self.generation
      let filename = URL(fileURLWithPath: name).lastPathComponent
      let destination = "/root/imports/\(UUID().uuidString)-\(filename)"
      self.lifecycle.async {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        do {
          let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
          guard attributes[.type] as? FileAttributeType == .typeRegular else {
            throw RuntimeFailure("invalid_file", "只能导入普通文件")
          }
          let result = source.path.withCString { input in destination.withCString { ww_runtime_import(input, $0) } }
          guard result == 0 else { throw RuntimeFailure("file_import", "文件导入失败（\(result)）") }
          self.queue.async {
            guard generation == self.generation && self.state == "running" else {
              RuntimeFailure("runtime_changed", "执行环境已切换").reject(promise); return
            }
            promise.resolve(["path": destination, "size": attributes[.size] as? NSNumber ?? 0])
          }
        } catch { (error as? RuntimeFailure ?? RuntimeFailure("file_import", error.localizedDescription)).reject(promise) }
      }
    }
  }
}
