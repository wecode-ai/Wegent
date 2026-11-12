from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "path",
    [
        "docker/knowledge_doc_converter/Dockerfile",
    ],
)
def test_converter_images_install_locked_dependencies(path):
    source = (Path(__file__).resolve().parents[2] / path).read_text()
    assert "knowledge_doc_converter/uv.lock" in source
    assert "uv export --locked --no-dev --no-emit-project" in source
    assert "-r pyproject.toml" not in source
    if "ENV UV_INDEX_URL=" in source:
        assert "--default-index https://pypi.org/simple" in source
