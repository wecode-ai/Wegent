# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from executor.agents.claude_code.prompt_enrichment import inject_kb_meta_prompt


class TestInjectKbMetaPrompt:
    def test_local_mode_injects_kb_meta_for_string_prompt(self):
        prompt = "Save this file to the selected knowledge base."
        kb_meta_prompt = (
            "Knowledge Bases In Scope:\n"
            "- KB Name: 222, KB ID: 1408\n"
            "Current Target KB:\n"
            "- KB Name: 222\n"
            "- KB ID: 1408"
        )

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=False,
        )

        assert result.startswith("<knowledge_base_guidance>\n")
        assert "<knowledge_base_context>\n" in result
        assert "Knowledge base routing:" in result
        assert "KB Name: 222, KB ID: 1408" in result
        assert result.endswith(prompt)

    def test_non_local_chat_task_injects_kb_meta(self):
        prompt = "Save this file to the selected knowledge base."
        kb_meta_prompt = "Available Knowledge Bases:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="docker",
            is_user_selected_kb=False,
            task_type="chat",
        )

        assert result.startswith("<knowledge_base_guidance>\n")
        assert "Knowledge base routing:" in result
        assert "KB Name: 222, KB ID: 1408" in result
        assert result.endswith(prompt)

    def test_code_task_does_not_inject_kb_meta(self):
        prompt = "Save this file to the selected knowledge base."
        kb_meta_prompt = "Available Knowledge Bases:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=False,
            task_type="code",
        )

        assert result == prompt

    def test_local_mode_injects_kb_meta_for_content_block_prompt(self):
        prompt = [{"type": "input_text", "text": "Save this file."}]
        kb_meta_prompt = "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=False,
        )

        assert result[0]["type"] == "input_text"
        assert result[0]["text"].startswith("<knowledge_base_guidance>\n")
        assert "<knowledge_base_context>\n" in result[0]["text"]
        assert "Knowledge base routing:" in result[0]["text"]
        assert "KB Name: 222, KB ID: 1408" in result[0]["text"]
        assert result[0]["text"].endswith("Save this file.")

    def test_local_mode_prioritizes_selected_kb_before_web_search(self):
        prompt = "Tell me about the selected knowledge base topic."
        kb_meta_prompt = "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=True,
        )

        assert "provided knowledge base id(s)" in result.lower()
        assert "web search" in result.lower()

    def test_local_mode_tells_executor_to_use_read_document_content_tool(self):
        prompt = "Read the selected knowledge base document."
        kb_meta_prompt = "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=True,
        )

        assert "wegent_kb_read_document_content" in result
        assert "document_id" in result
        assert "offset" in result
        assert "limit" in result
        assert "wegent_kb_list_documents" in result
        assert "do not construct mcp resource uris manually" in result.lower()

    def test_local_mode_tells_executor_to_list_documents_before_reading(
        self,
    ):
        prompt = "Find the relevant knowledge base passage."
        kb_meta_prompt = "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="local",
            is_user_selected_kb=True,
        )

        assert "wegent_kb_list_documents" in result
        assert "identify which document matters" in result.lower()

    def test_guidance_routes_provided_kb_first_then_broadens(self):
        prompt = "What does the selected knowledge base say?"
        kb_meta_prompt = "Knowledge Bases In Scope:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="docker",
            is_user_selected_kb=True,
            task_type="chat",
        )

        assert "were selected by the user" in result
        assert "First answer by querying the provided knowledge base ID(s)" in result
        assert "broaden the query to all knowledge bases" in result
        assert "then use web search or other external tools" in result

    def test_available_kb_guidance_uses_same_fallback_order(self):
        prompt = "What can you help me with?"
        kb_meta_prompt = "Available Knowledge Bases:\n- KB Name: 222, KB ID: 1408"

        result = inject_kb_meta_prompt(
            prompt,
            kb_meta_prompt,
            executor_mode="docker",
            is_user_selected_kb=False,
            task_type="chat",
        )

        assert "provides knowledge base IDs that may answer the request" in result
        assert "First answer by querying the provided knowledge base ID(s)" in result
        assert "broaden the query to all knowledge bases" in result
        assert "then use web search or other external tools" in result
