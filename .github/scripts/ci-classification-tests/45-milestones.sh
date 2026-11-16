# Milestone declarations retain an active CI owner after catalog discovery.
for milestone_path in \
  "wework/e2e/desktop/catalog/collaboration-milestones.json" \
  "wework/e2e/desktop/scenarios/collaboration-milestones.scenario.mjs" \
  "backend/app/services/project_milestones.py"
do
  assert_desktop_case "milestone changes retain real local/cloud coverage: $milestone_path" \
    'wework_desktop_e2e=true
wework_desktop_core_e2e=true
wework_desktop_core_e2e_matrix={"include":[{"id":"core-6","name":"Core / shard 6","segments":"collaboration-milestones"}]}
wework_desktop_other_e2e=false
wework_desktop_other_e2e_matrix={"include":[]}' \
    "$milestone_path"
done
