# Sourced by test-classify-ci-changes.sh; reuse its existing classifier contracts.

workday_expected="${shared_expected/backend_rs=false/backend_rs=true}"
workday_expected="${workday_expected/executor=false/executor=true}"
workday_expected="${workday_expected/wework_e2e=false/wework_e2e=true}"
for workday_input in \
  shared/assets/calendars/china-workdays.json \
  shared/assets/calendars/LICENSE.chinesecalendar; do
  assert_case "calendar-only changes validate both offline consumers: $workday_input" \
    "$workday_expected" "$workday_input"
  workday_desktop_expected="$(GITHUB_OUTPUT=/dev/stdout "$desktop_classifier" \
    wework/e2e/desktop/catalog/workday-schedules.json)"
  assert_desktop_case "calendar data keeps existing personal/project native scenarios: $workday_input" \
    "$workday_desktop_expected" "$workday_input"
done
