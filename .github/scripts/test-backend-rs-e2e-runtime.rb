#!/usr/bin/env ruby

require "yaml"
require "tmpdir"
require "fileutils"
require "open3"

root = File.expand_path("../..", __dir__)
workflows = File.join(root, ".github/workflows")
jobs = YAML.safe_load(File.read(File.join(workflows, "e2e-tests.yml"))).fetch("jobs")
producer = jobs.fetch("build-backend-rs-e2e-runtime")
delivery_job = jobs.fetch("verify-backend-delivery-image")
summary = jobs.fetch("platform-e2e-summary").fetch("steps").first.fetch("env")
%w[pull_request merge_group schedule workflow_dispatch].each do |event|
  [false, true].repeated_permutation(4) do |platform, desktop, delivery, draft|
    values = {
      "github.event_name" => event,
      "github.event.pull_request.draft" => draft,
      "needs.changes.outputs.platform_e2e" => platform.to_s,
      "needs.changes.outputs.wework_desktop_e2e" => desktop.to_s,
      "needs.changes.outputs.backend_delivery_image" => delivery.to_s
    }
    evaluate = lambda do |expression|
      expression = expression.delete_prefix("${{ ").delete_suffix(" }}")
      values.each { |key, value| expression = expression.gsub(key, value.inspect) }
      eval(expression)
    end
    runtime_required = event != "pull_request" || (!draft && (platform || desktop))
    delivery_required = delivery && (event != "pull_request" || !draft)
    [
      [producer.fetch("if"), runtime_required],
      [summary.fetch("RUN_BACKEND_RUNTIME"), runtime_required],
      [delivery_job.fetch("if"), delivery_required],
      [summary.fetch("RUN_DELIVERY"), delivery_required]
    ].each do |expression, expected|
      unless evaluate.call(expression) == expected
        raise "Backend job selection differs for event=#{event}, platform=#{platform}, desktop=#{desktop}, delivery=#{delivery}, draft=#{draft}: #{expression}"
      end
    end
  end
end
steps = producer.fetch("steps")
step = ->(name) { steps.find { |candidate| candidate["name"] == name }.fetch("run") }
digest = steps.find { |candidate| candidate["id"] == "runtime" }
  .fetch("env").fetch("SOURCE_DIGEST")

recipe = ".github/runtime-images/backend-rs-e2e.Dockerfile"
%W[backend-rs/crates/** shared/rust/** shared/assets/codex-models/** backend-rs/examples/** backend-rs/migrations/** #{recipe} .github/runtime-images/backend-rs-builder.Dockerfile].each do |input|
  raise "Backend Rust runtime digest omits #{input}" unless digest.include?("'#{input}'")
end

# Compile-time migration assets must exist at the same relative paths inside the
# builder. Check the actual include paths against its COPY instructions.
builder = File.read(File.join(root, ".github/runtime-images/backend-rs-builder.Dockerfile"))
unless builder.include?("COPY shared/assets/codex-models /workspace/shared/assets/codex-models")
  raise "Backend Rust builder omits the embedded Codex model catalogs"
end
copies = builder.scan(/^COPY (backend-rs\/\S+) (\.\/\S+)$/)
Dir[File.join(root, "backend-rs/src/migrations/**/*.rs")].each do |source|
  File.read(source).scan(/include_(?:str|bytes)!\(\s*"([^"]+)"/).flatten.each do |path|
    asset = File.expand_path(path, File.dirname(source))
    relative = asset.delete_prefix("#{root}/backend-rs/")
    copied = copies.any? do |input, destination|
      prefix = destination.delete_prefix("./")
      candidate = File.join(root, input, relative.delete_prefix("#{prefix}/"))
      relative.start_with?("#{prefix}/") && File.file?(candidate)
    end
    raise "Backend Rust builder omits embedded asset #{relative}" unless copied
  end
end
%w[wework-e2e.yml ci-cache-warmup.yml].each do |name|
  definition = YAML.safe_load(File.read(File.join(workflows, name)))
  consumers = definition.fetch("jobs").values.flat_map { |job| job.fetch("steps", []) }
    .select { |candidate| candidate["name"] == "Resolve shared Rust E2E runtimes" }
  raise "#{name} must resolve the shared runtime" if consumers.empty?
  consumers.each do |consumer|
    unless consumer.fetch("env").fetch("BACKEND_RS_SOURCE_DIGEST") == digest
      raise "#{name} uses a different Backend Rust image cache key from the producer"
    end
  end
end

# Execute the actual workflow steps with process-boundary fixtures. These are
# workflow unit tests, not substitutes for the CI's real storage/desktop E2E.
Dir.mktmpdir("backend-rs-runtime-contract") do |directory|
  FileUtils.mkdir_p(File.join(directory, File.dirname(recipe)))
  FileUtils.cp(File.join(root, recipe), File.join(directory, recipe))
  %w[.github/runtime-images/backend-rs-builder.Dockerfile .github/ci/rust-toolchain
    .github/scripts/ci-prebuilt-images.mjs .github/scripts/resolve-ci-image.mjs backend-rs/Cargo.toml backend-rs/Cargo.lock].each do |input|
    FileUtils.mkdir_p(File.dirname(File.join(directory, input)))
    FileUtils.cp(File.join(root, input), File.join(directory, input))
  end
  %w[backend-rs/crates shared/rust].each do |input|
    FileUtils.mkdir_p(File.dirname(File.join(directory, input)))
    FileUtils.cp_r(File.join(root, input), File.join(directory, input))
  end
  bin = File.join(directory, "bin")
  FileUtils.mkdir_p(bin)
  File.write(File.join(bin, "cargo"), <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    while (($#)); do
      case "$1" in
        --bin) artifact="$CARGO_TARGET_DIR/release/$2"; shift ;;
        --example) artifact="$CARGO_TARGET_DIR/release/examples/$2"; shift ;;
        *) shift; continue ;;
      esac
      mkdir -p "$(dirname "$artifact")"
      printf '#!/bin/sh\nexit 0\n' > "$artifact"
      chmod 0755 "$artifact"
      shift
    done
  SH
  File.write(File.join(bin, "docker"), <<~'SH')
    #!/usr/bin/env bash
    set -euo pipefail
    case "$1" in
      build)
        context="${@: -1}"
        shift
        while (($# > 1)); do
          case "$1" in
            --file) recipe="$2"; shift 2 ;;
            --tag|--platform|--target|--build-arg) shift 2 ;;
            *) exit 1 ;;
          esac
        done
        test -f "${recipe:?Docker build must use its checked-in recipe}"
        mkdir -p "$TEST_IMAGE/app"
        if [[ "$recipe" == .github/runtime-images/backend-rs-builder.Dockerfile ]]; then
          for binary in wegent-backend-rs attachment-s3-e2e attachment-hosting-e2e; do
            printf '#!/bin/sh\nexit 0\n' > "$TEST_IMAGE/app/$binary"
            chmod 0755 "$TEST_IMAGE/app/$binary"
          done
          exit 0
        fi
        while read -r instruction source destination; do
          [[ "$instruction" == COPY ]] || continue
          cp "$context/$source" "$TEST_IMAGE$destination"
        done < "$recipe"
        ;;
      manifest) exit 1 ;;
      push|pull) ;;
      create) echo contract-container ;;
      cp) cp "$TEST_IMAGE/${2#*:/}" "$3" ;;
      rm) touch "$TEST_CLEANUP" ;;
      *) exit 1 ;;
    esac
  SH
  FileUtils.chmod(0755, Dir[File.join(bin, "*")])
  environment = {
    "PATH" => "#{bin}:#{ENV.fetch('PATH')}",
    "GITHUB_REPOSITORY_OWNER" => "example",
    "CARGO_TARGET_DIR" => File.join(directory, "target"),
    "IMAGE" => "contract-image",
    "TEST_IMAGE" => File.join(directory, "image"),
    "TEST_CLEANUP" => File.join(directory, "cleanup")
  }
  run = lambda do |name, success|
    output, status = Open3.capture2e(environment, "bash", "-e", "-o", "pipefail", "-c",
      step.call(name), chdir: directory)
    raise "#{name} exited #{status.exitstatus}:\n#{output}" unless status.success? == success
  end
  run.call("Build Backend Rust E2E runtime", true)
  run.call("Publish content-addressed Backend Rust E2E image", true)
  FileUtils.rm_rf(File.join(directory, ".ci-artifacts"))
  run.call("Restore content-addressed Backend Rust E2E binary", true)
  artifacts = %w[wegent-backend-rs attachment-s3-e2e attachment-hosting-e2e]
  artifacts.each do |artifact|
    raise "Runtime restoration lost #{artifact}" unless File.executable?(
      File.join(directory, ".ci-artifacts", artifact))
  end
  raise "Cached container was not released" unless File.exist?(environment.fetch("TEST_CLEANUP"))
  artifacts.each do |artifact|
    FileUtils.rm(environment.fetch("TEST_CLEANUP"))
    path = File.join(directory, "image/app", artifact)
    content = File.binread(path)
    FileUtils.rm(path)
    run.call("Restore content-addressed Backend Rust E2E binary", false)
    raise "Failed #{artifact} restore leaked its container" unless File.exist?(
      environment.fetch("TEST_CLEANUP"))
    File.binwrite(path, content)
  end
end

puts "Backend Rust E2E artifact and shared cache-key contract tests passed"
