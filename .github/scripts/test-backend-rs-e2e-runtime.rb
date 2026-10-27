#!/usr/bin/env ruby

require "yaml"
require "tmpdir"
require "fileutils"
require "open3"

root = File.expand_path("../..", __dir__)
workflows = File.join(root, ".github/workflows")
producer = YAML.safe_load(File.read(File.join(workflows, "e2e-tests.yml")))
  .fetch("jobs").fetch("build-backend-rs-e2e-runtime")
steps = producer.fetch("steps")
step = ->(name) { steps.find { |candidate| candidate["name"] == name }.fetch("run") }
digest = steps.find { |candidate| candidate["id"] == "runtime" }
  .fetch("env").fetch("SOURCE_DIGEST")

%w[backend-rs/examples/** .github/workflows/e2e-tests.yml].each do |input|
  raise "Backend Rust runtime digest omits #{input}" unless digest.include?("'#{input}'")
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
        mkdir -p "$TEST_IMAGE/app"
        while read -r instruction source destination; do
          [[ "$instruction" == COPY ]] || continue
          cp "$context/$source" "$TEST_IMAGE$destination"
        done < "$context/Dockerfile"
        ;;
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
  %w[wegent-backend-rs attachment-s3-e2e].each do |artifact|
    raise "Runtime restoration lost #{artifact}" unless File.executable?(
      File.join(directory, ".ci-artifacts", artifact))
  end
  raise "Cached container was not released" unless File.exist?(environment.fetch("TEST_CLEANUP"))
  FileUtils.rm(environment.fetch("TEST_CLEANUP"))
  FileUtils.rm(File.join(directory, "image/app/attachment-s3-e2e"))
  run.call("Restore content-addressed Backend Rust E2E binary", false)
  raise "Failed restore leaked its container" unless File.exist?(environment.fetch("TEST_CLEANUP"))
end

puts "Backend Rust E2E artifact and shared cache-key contract tests passed"
