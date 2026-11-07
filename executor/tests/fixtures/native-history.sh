#!/bin/sh
directory=$(dirname -- "$0")
cd / || exit 1
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$directory/requests.jsonl"
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  [ -n "$id" ] || continue
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method":"\([^"]*\)".*/\1/p' | tr '/' '_')
  case "$method:$line" in thread_list:*'"cursor":"page-2"'*) method=thread_list_page2;; esac
  if [ "$method" = "test_stop" ]; then
    printf '{"id":%s,"result":{}}\n' "$id"
    exit 0
  fi
  error_file="$directory/$method.error-once.json"
  if [ -f "$error_file" ]; then
    printf '{"id":%s,"error":' "$id"
    cat "$error_file"
    rm "$error_file"
    printf '}\n'
    continue
  fi
  printf '{"id":%s,"result":' "$id"
  cat "$directory/$method.json"
  printf '}\n'
done
