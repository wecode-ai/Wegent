import ExpoModulesCore

public final class WeworkLocalRuntimeModule: Module {
  private var subscription: UUID?
  private let runtime = LocalRuntimeSupervisor.shared

  public func definition() -> ModuleDefinition {
    Name("WeworkLocalRuntime")
    Events("onRuntimeEvent", "onRuntimeStatus")
    OnCreate { [weak self] in
      guard let self else { return }
      self.subscription = self.runtime.subscribe { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }
    OnDestroy { [weak self] in
      guard let self, let subscription = self.subscription else { return }
      self.runtime.unsubscribe(subscription)
    }
    AsyncFunction("getStatusAsync") { (promise: Promise) in self.runtime.status(promise) }
    AsyncFunction("listProfilesAsync") { (promise: Promise) in self.runtime.listProfiles(promise) }
    AsyncFunction("startAsync") { (options: [String: Any], promise: Promise) in
      self.runtime.start(options, promise: promise)
    }
    AsyncFunction("requestAsync") { (options: [String: Any], promise: Promise) in
      self.runtime.request(options, promise: promise)
    }
    AsyncFunction("stopAsync") { (options: [String: Any], promise: Promise) in
      self.runtime.stop(options, promise: promise)
    }
    AsyncFunction("getEventsAsync") { (options: [String: Any], promise: Promise) in
      self.runtime.events(options, promise: promise)
    }
    AsyncFunction("importFileAsync") { (options: [String: Any], promise: Promise) in
      self.runtime.importFile(options, promise: promise)
    }
  }
}
