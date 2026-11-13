# Sourced by test-classify-ci-changes.sh; all assertions share its helpers.

for converter_path in \
  knowledge_doc_converter/uv.lock \
  knowledge_doc_converter/tests/test_locked_build.py \
  docker/knowledge_doc_converter/Dockerfile; do
  assert_case "Converter changes run knowledge tests: $converter_path" \
    "${all_false/knowledge_engine=false/knowledge_engine=true}" "$converter_path"
done
