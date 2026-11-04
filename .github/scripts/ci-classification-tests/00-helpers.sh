# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

workflow_has_top_level_trigger() {
  local workflow_path="$1"
  local trigger="$2"

  awk -v target="$trigger" '
    function normalize_token(token) {
      gsub(/^[[:space:]"]+|[[:space:]"]+$/, "", token)
      gsub(/^\047+|\047+$/, "", token)
      return token
    }

    function inline_has_target(value, tokens, token_count, token_index) {
      sub(/[[:space:]]+#.*/, "", value)
      gsub(/[\[\],]/, " ", value)
      token_count = split(value, tokens, /[[:space:]]+/)
      for (token_index = 1; token_index <= token_count; token_index++) {
        if (normalize_token(tokens[token_index]) == target) return 1
      }
      return 0
    }

    /^[[:space:]]*(#|$)/ {
      next
    }

    {
      line = $0
      if (!in_on) {
        if (line !~ /^on:[[:space:]]*/) next
        sub(/^on:[[:space:]]*/, "", line)
        sub(/^[[:space:]]*#.*/, "", line)
        if (line != "") {
          found = inline_has_target(line)
          exit
        }
        in_on = 1
        child_indent = -1
        next
      }

      if (line ~ /^[^[:space:]]/) exit

      indentation = line
      sub(/[^[:space:]].*$/, "", indentation)
      indent = length(indentation)
      if (child_indent == -1) child_indent = indent
      if (indent != child_indent) next

      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]+#.*/, "", line)
      sub(/^-[[:space:]]*/, "", line)
      sub(/:.*/, "", line)
      if (normalize_token(line) == target) {
        found = 1
        exit
      }
    }

    END {
      exit found ? 0 : 1
    }
  ' "$workflow_path"
}

assert_workflow_trigger_case() {
  local name="$1"
  local expected="$2"
  local workflow="$3"
  local actual="false"

  if workflow_has_top_level_trigger <(printf '%s\n' "$workflow") "push"; then
    actual="true"
  fi
  if [[ "$actual" != "$expected" ]]; then
    printf 'Workflow trigger case "%s" failed.\n' "$name" >&2
    exit 1
  fi
}

extract_named_workflow_step() {
  local workflow_path="$1"
  local step_name="$2"

  awk -v target="$step_name" '
    found && /^      - name:/ {
      exit
    }
    $0 == "      - name: " target {
      found = 1
    }
    found {
      print
    }
  ' "$workflow_path"
}

extract_named_workflow_step_from_job() {
  local workflow_path="$1"
  local job_start="$2"
  local job_end="$3"
  local step_name="$4"
  awk \
    -v job_start="$job_start" \
    -v job_end="$job_end" \
    -v target="$step_name" '
      $0 == job_start {
        in_job = 1
        next
      }
      in_job && $0 == job_end {
        in_job = 0
      }
      !in_job {
        next
      }
      found && /^      - name:/ {
        found = 0
      }
      $0 == "      - name: " target {
        found = 1
      }
      found {
        print
      }
    ' "$workflow_path"
}

assert_case() {
  local name="$1"
  local expected="$2"
  shift 2

  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$classifier" "$@")"
  if [[ "$output" != "$expected" ]]; then
    printf 'Case "%s" failed.\nExpected:\n%s\nActual:\n%s\n' "$name" "$expected" "$output" >&2
    exit 1
  fi
}

all_false=$(
  cat <<'EOF'
backend=false
backend_rs=false
executor=false
executor_manager=false
shared=false
knowledge_engine=false
frontend=false
wework=false
wegent_cli=false
platform_e2e=false
wework_e2e=false
EOF
)

normalize_desktop_checkpoint_order() {
  node -e '
    const fs = require("node:fs")
    const lines = fs.readFileSync(0, "utf8").trimEnd().split("\n")
    process.stdout.write(lines.map(line => {
      const boundary = line.indexOf("=")
      if (!line.slice(0, boundary).endsWith("_e2e_matrix")) return line
      const matrix = JSON.parse(line.slice(boundary + 1))
      for (const entry of matrix.include) {
        if (typeof entry.segments === "string") {
          entry.segments = entry.segments.split(",").sort().join(",")
        }
      }
      return line.slice(0, boundary + 1) + JSON.stringify(matrix)
    }).join("\n"))
  '
}

assert_desktop_case() {
  local name="$1"
  local expected="$2"
  shift 2

  if [[ "$expected" != *"wework_desktop_cloud_e2e="* ]]; then
    local cloud_defaults
    cloud_defaults='wework_desktop_cloud_e2e=false
wework_desktop_cloud_e2e_matrix={"include":[]}
wework_desktop_other_e2e='
    expected="${expected/wework_desktop_other_e2e=/$cloud_defaults}"
  fi
  if [[ "$expected" != *"wework_desktop_macos_inspector_e2e="* ]]; then
    expected="${expected}"$'\n''wework_desktop_macos_inspector_e2e=false'
  fi
  local output
  output="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" "$@")"
  # Every checkpoint owns its prerequisites; order within one shard is not coverage.
  if [[ "$output" != "$expected" ]]; then
    local normalized_output normalized_expected
    normalized_output="$(printf '%s' "$output" | normalize_desktop_checkpoint_order)"
    normalized_expected="$(printf '%s' "$expected" | normalize_desktop_checkpoint_order)"
    if [[ "$normalized_output" == "$normalized_expected" ]]; then return; fi
    printf 'Desktop case "%s" failed.\nExpected:\n%s\nActual:\n%s\n' \
      "$name" "$expected" "$output" >&2
    exit 1
  fi
}

assert_desktop_comparison_preserves_coverage() {
  local expected reordered moved missing duplicated
  expected='wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","segments":"a,b"},{"id":"core-2","segments":"c"}]}'
  reordered="${expected/a,b/b,a}"
  moved='wework_desktop_core_e2e_matrix={"include":[{"id":"core-1","segments":"a"},{"id":"core-2","segments":"b,c"}]}'
  missing="${expected/a,b/a}"
  duplicated="${expected/a,b/a,a,b}"
  expected="$(printf '%s' "$expected" | normalize_desktop_checkpoint_order)"
  [[ "$expected" == "$(printf '%s' "$reordered" | normalize_desktop_checkpoint_order)" ]]
  [[ "$expected" != "$(printf '%s' "$moved" | normalize_desktop_checkpoint_order)" ]]
  [[ "$expected" != "$(printf '%s' "$missing" | normalize_desktop_checkpoint_order)" ]]
  [[ "$expected" != "$(printf '%s' "$duplicated" | normalize_desktop_checkpoint_order)" ]]
}

assert_desktop_comparison_preserves_coverage

