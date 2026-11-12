# Sourced by test-classify-ci-changes.sh.
for path in knowledge_doc_converter/uv.lock \
  docker/knowledge_doc_converter/Dockerfile; do
  assert_case "Converter changes run knowledge checks without platform E2E: $path" \
    "${all_false/knowledge_engine=false/knowledge_engine=true}" "$path"
done
