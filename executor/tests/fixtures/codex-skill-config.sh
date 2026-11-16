#!/bin/sh
if [ "$1" = debug ]; then
  printf '%s\n' "${WEGENT_TEST_CODEX_BUNDLED_CATALOG:?}"
  exit 0
fi
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$CODEX_HOME/requests.jsonl"
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*) printf '{"id":%s,"result":{}}\n' "$id" ;;
    *'"method":"skills/config/write"'*)
      printf '%s\n' written > "$CODEX_HOME/skill-written"
      printf '{"id":%s,"result":{"effectiveEnabled":false}}\n' "$id" ;;
    *'"method":"config/batchWrite"'*)
      mode=success
      if [ -f "$CODEX_HOME/reload-mode" ]; then
        IFS= read -r mode < "$CODEX_HOME/reload-mode"
      fi
      case "$mode" in
        failure) printf '{"id":%s,"error":{"code":-32603,"message":"skill reload rejected"}}\n' "$id" ;;
        blocked) ;;
        *) printf '{"id":%s,"result":{"status":"ok"}}\n' "$id" ;;
      esac ;;
  esac
done
