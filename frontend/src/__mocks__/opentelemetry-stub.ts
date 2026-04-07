// Mock for OpenTelemetry instrumentation packages to avoid ESM issues in Jest

export class FetchInstrumentation {
  constructor() {
    // No-op
  }
  setTracerProvider() {
    // No-op
  }
  setMeterProvider() {
    // No-op
  }
  enable() {
    // No-op
  }
  disable() {
    // No-op
  }
}

export class XMLHttpRequestInstrumentation {
  constructor() {
    // No-op
  }
  setTracerProvider() {
    // No-op
  }
  setMeterProvider() {
    // No-op
  }
  enable() {
    // No-op
  }
  disable() {
    // No-op
  }
}

export default FetchInstrumentation
