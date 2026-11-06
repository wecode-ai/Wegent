#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKFLOW="$PROJECT_ROOT/.github/workflows/publish-image.yml"

release_step="$(
    awk '
        /^      - name: Create GitHub Release$/ {
            in_step = 1
        }
        in_step && /^      - name:/ && $0 !~ /Create GitHub Release$/ {
            exit
        }
        in_step {
            print
        }
    ' "$WORKFLOW"
)"

if [ -z "$release_step" ]; then
    echo "Create GitHub Release step was not found."
    exit 1
fi

if ! grep -Fq "make_latest: false" <<< "$release_step"; then
    echo "Wegent releases must not be marked as the latest GitHub release."
    exit 1
fi

ruby -ryaml -rpathname -rtmpdir -rfileutils - "$PROJECT_ROOT" <<'RUBY'
root = ARGV.fetch(0)
%w[publish-image snapshot-image].each do |name|
  workflow = YAML.load_file(File.join(root, ".github/workflows/#{name}.yml"))
  if name == 'publish-image'
    reference = workflow.fetch('env').fetch('GIT_REF')
    raise 'Manual releases must pin the triggering commit, not a moving branch' unless reference.match?(/\|\|\s*github\.sha\s*}}/)
    raise 'Merged PR releases must pin the merge commit' unless reference.include?('github.event.pull_request.merge_commit_sha')
    workflow.fetch('jobs').each do |job, definition|
      definition.fetch('steps', []).each do |step|
        if step.fetch('uses', '').start_with?('actions/checkout@')
          raise "#{job}: checkout must use the shared immutable revision" unless step.dig('with', 'ref') == '${{ env.GIT_REF }}'
        end
        arguments = step.dig('with', 'build-args').to_s
        if arguments.include?('WEWORK_SOURCE_SHA=')
          raise "#{job}: embedded source must match checkout" unless arguments.include?('WEWORK_SOURCE_SHA=${{ env.GIT_REF }}')
        end
      end
    end
  end
  workflow.fetch('jobs').each do |job, definition|
    runners = [definition['runs-on'], *definition.dig('strategy', 'matrix', 'include')&.map { |entry| entry['runner'] }].compact
    raise "#{name}/#{job}: retired macOS runner" if runners.any? { |runner| runner.to_s.start_with?('macos-14') }
    steps = definition.fetch('steps', [])
    steps.each do |step|
      action = step.fetch('uses', '')
      next unless action.start_with?('./')
      directory = File.join(root, action)
      raise "#{name}/#{job}: missing local action #{action}" unless %w[action.yml action.yaml Dockerfile].any? { |file|
        File.file?(File.join(directory, file))
      }
    end
    builds = steps.select { |step| step.fetch('run', '').include?('cargo build --release') }
    next if builds.empty?
    setup = steps.find { |step| step['uses'] == './.github/actions/setup-rust-cache' }
    raise "#{name}/#{job}: missing shared executor toolchain" unless setup&.dig('with', 'manifest-path') == 'executor/Cargo.toml'
    builds.each do |step|
      script = step.fetch('run')
      if step['shell'] == 'pwsh'
        raise "#{name}/#{job}: wrong Windows output path" unless script.include?('Copy-Item "$env:CARGO_TARGET_DIR/release/wegent-executor.exe"')
        next
      end
      # Execute the packaging commands with compiler output outside the checkout.
      Dir.mktmpdir('executor-release-') do |directory|
        target = File.join(directory, 'cargo target')
        cross = script.include?('--target x86_64-apple-darwin')
        binary = File.join(target, cross ? 'x86_64-apple-darwin/release/wegent-executor' : 'release/wegent-executor')
        FileUtils.mkdir_p(File.dirname(binary))
        File.write(binary, "#!/bin/sh\n[ \"$1\" = --version ] && [ \"$WEGENT_EXECUTOR_VERSION\" = 1.2.3 ]\n")
        FileUtils.chmod(0755, binary)
        command = "set -euo pipefail\ncargo() { :; }\n#{script}"
        raise "#{name}/#{job}: packaging failed" unless system(
          {'CARGO_TARGET_DIR' => target, 'APP_VERSION' => '1.2.3'},
          'bash', '-c', command, chdir: directory
        )
        raise "#{name}/#{job}: binary was not packaged" unless File.file?(File.join(directory, 'dist/wegent-executor'))
      end
    end
  end
end

# Check the imported template exists in each isolated Docker build stage.
source = File.join(root, 'packages/collaboration/src/templates/builtins.ts')
import = File.read(source).match(/from ['"]([^'"]+\.json)['"]/).captures.first
dependency = Pathname.new(File.expand_path(import, File.dirname(source))).relative_path_from(Pathname.new(root)).to_s
{'docker/frontend/Dockerfile' => ['builder'], 'docker/standalone/Dockerfile' => %w[frontend-builder wework-builder]}.each do |path, stages|
  contents = File.read(File.join(root, path))
  stages.each do |stage|
    body = contents.split(/^FROM .* AS #{stage}\s*$/i, 2).fetch(1).split(/^FROM /, 2).first
    copies = body.scan(/^COPY (?!.*--from=)(\S+) (\S+)$/)
    present = copies.any? do |source_path, destination|
      next false unless destination.start_with?('./')
      destination = destination.delete_prefix('./').delete_suffix('/')
      next false unless dependency == destination || dependency.start_with?("#{destination}/")
      relative = dependency.delete_prefix(destination).delete_prefix('/')
      File.file?(File.join(root, source_path, relative))
    end
    raise "#{path}/#{stage}: missing #{dependency}" unless present
  end
end
RUBY

echo "publish-image release policy regression test passed"
