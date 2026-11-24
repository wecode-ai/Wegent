#!/bin/sh
directory=$(dirname -- "$0")
if [ "$1" = debug ]; then
  cat "$directory/bundled_models.json"
  exit $?
fi
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
  [ ! -f "$directory/$method.defer" ] || continue
  while [ -f "$directory/$method.hold" ]; do sleep 0.01; done
  error_file="$directory/$method.error-once.json"
  if [ -f "$error_file" ]; then
    mv "$error_file" "$error_file.consumed" || exit 1
    printf '{"id":%s,"error":' "$id"
    cat "$error_file.consumed"
    printf '}\n'
    continue
  fi
  notification_file="$directory/$method.notifications.jsonl"
  if [ -f "$notification_file" ]; then
    cat "$notification_file"
  fi
  printf '{"id":%s,"result":' "$id"
  cat "$directory/$method.json"
  printf '}\n'
done
