#!/bin/sh
if [ "$CAPTURE_TEST_STARTUP_DELAY" != 0 ]; then
  /bin/sleep "$CAPTURE_TEST_STARTUP_DELAY"
fi
printf '%s\n' "$$" > "$CAPTURE_TEST_PID"
if [ "$CAPTURE_TEST_EXIT_DELAY" = 0 ]; then
  exec /bin/cat "$CAPTURE_TEST_FIFO"
fi
/bin/cat "$CAPTURE_TEST_FIFO"
/bin/sleep "$CAPTURE_TEST_EXIT_DELAY"
