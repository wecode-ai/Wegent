#!/bin/sh
# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

profile_loaded=false
profile_restored=false
if [ -f "$0.loaded" ]; then profile_loaded=true; fi
while IFS= read -r line; do
  printf '%s\n' "$line" >> "$0.requests"
  request_id=$(printf '%s\n' "$line" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"id":%s,"result":{"protocolVersion":1}}\n' "$request_id"
      ;;
    *'"method":"initialized"'*) ;;
    *'"method":"thread/unsubscribe"'*)
      if [ "$profile_loaded" = true ]; then
        printf '{"id":%s,"result":{"status":"unsubscribed"}}\n' "$request_id"
        printf '%s\n' '{"method":"thread/closed","params":{"threadId":"thread-1"}}'
      else
        printf '{"id":%s,"result":{"status":"notLoaded"}}\n' "$request_id"
      fi
      profile_loaded=false
      ;;
    *'"method":"thread/resume"'*)
      if [ "$profile_loaded" = false ]; then profile_restored=true; fi
      profile_loaded=true
      printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$request_id"
      ;;
    *'"method":"thread/turns/list"'*)
      printf '{"id":%s,"result":{"data":[{"id":"previous-turn","itemsView":"notLoaded"}],"nextCursor":null}}\n' "$request_id"
      ;;
    *'"method":"thread/read"'*)
      printf '{"id":%s,"result":{"thread":{"id":"thread-1","cwd":"/tmp/project","status":"idle","turns":[]}}}\n' "$request_id"
      ;;
    *'"method":"thread/compact/start"'*)
      printf '{"id":%s,"result":{}}\n' "$request_id"
      if [ "$profile_restored" = false ]; then
        printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"compact-turn","status":"failed","error":{"message":"process discovery profile retained"}}}}'
        continue
      fi
      printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"compact-turn","status":"inProgress"}}}'
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"compact-turn","item":{"id":"compact-item","type":"contextCompaction"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"compact-turn","status":"completed"}}}'
      ;;
    *)
      if [ -n "$request_id" ]; then printf '{"id":%s,"result":{}}\n' "$request_id"; fi
      ;;
  esac
done
