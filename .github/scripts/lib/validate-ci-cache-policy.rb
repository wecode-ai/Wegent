#!/usr/bin/env ruby

require "yaml"

def load_yaml(path)
  source = path == "-" ? $stdin.read : File.read(path)
  YAML.safe_load(
    source,
    permitted_classes: [],
    permitted_symbols: [],
    aliases: false
  ) || {}
rescue Psych::Exception => e
  warn "Unable to parse #{path}: #{e.message}"
  exit 1
end

def each_step(value, &block)
  case value
  when Hash
    value.each do |key, child|
      child.each(&block) if key == "steps" && child.is_a?(Array)
      each_step(child, &block)
    end
  when Array
    value.each { |child| each_step(child, &block) }
  end
end

def reject(path, message)
  warn "CI cache policy violation in #{path}: #{message}"
  exit 1
end

def positive_guard?(condition, left, right)
  expression = condition.strip
  expression = expression.sub(/\A\$\{\{\s*/, "").sub(/\s*\}\}\z/, "")
  return false if expression.include?("||")

  guard = Regexp.new(
    "\\A#{Regexp.escape(left)}\\s*==\\s*(['\"])" \
    "#{Regexp.escape(right)}\\1\\z"
  )
  expression.split("&&").any? { |clause| clause.strip.match?(guard) }
end

mode = ARGV.shift
reject("<arguments>", "missing validation mode") unless mode
reject("<arguments>", "missing YAML files") if ARGV.empty?

ARGV.each do |path|
  each_step(load_yaml(path)) do |step|
    next unless step.is_a?(Hash)

    uses = step["uses"].to_s
    condition = step["if"].to_s

    case mode
    when "workflow-cache"
      next unless uses.start_with?("actions/cache/save@")
      next if positive_guard?(condition, "github.ref", "refs/heads/main")

      reject(path, "#{uses} must be guarded by the main branch")
    when "action-cache"
      next unless uses.match?(%r{\Aactions/cache(?:/save)?@})
      next if positive_guard?(condition, "inputs.save-cache", "true")

      reject(path, "#{uses} must be guarded by inputs.save-cache")
    when "checkout"
      next unless uses.start_with?("actions/checkout@")
      next if [false, "false"].include?(step.fetch("with", {})["persist-credentials"])

      reject(path, "#{uses} must set persist-credentials: false")
    when "docker-sha"
      match = uses.match(
        %r{\Adocker/(?:login|setup-buildx|build-push)-action@(.+)\z}
      )
      next unless match
      next if match[1].match?(/\A[0-9a-fA-F]{40}\z/)

      reject(path, "#{uses} must use a full commit SHA")
    else
      reject("<arguments>", "unknown validation mode: #{mode}")
    end
  end
end
