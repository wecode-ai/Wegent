# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Unit tests for Skill service
"""
import io
import zipfile

import pytest
from fastapi import HTTPException

from app.services.skill_service import SkillValidator


@pytest.mark.unit
class TestSkillValidator:
    """Test SkillValidator class"""

    @staticmethod
    def create_test_zip(files: dict, zip_name: str = "test") -> bytes:
        """
        Helper function to create a ZIP file with specified files.

        Args:
            files: Dictionary mapping filename to content
            zip_name: Name of the ZIP file (used for folder structure)

        Returns:
            ZIP file binary content
        """
        zip_buffer = io.BytesIO()
        folder_name = zip_name.replace(".zip", "")
        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            for filename, content in files.items():
                # If filename already contains a path, use it as-is
                # Otherwise, prepend the folder name
                if "/" in filename:
                    zip_file.writestr(filename, content)
                else:
                    zip_file.writestr(f"{folder_name}/{filename}", content)
        return zip_buffer.getvalue()

    def test_validate_zip_success(self):
        """Test successful ZIP validation with valid SKILL.md"""
        skill_md_content = """---
description: "Test skill for debugging"
version: "1.0.0"
author: "Test Author"
tags: ["test", "debug"]
---

# Test Skill

This is a test skill.

"""
        zip_content = self.create_test_zip(
            {"SKILL.md": skill_md_content, "script.py": "print('hello')"}, "test.zip"
        )

        result = SkillValidator.validate_zip(zip_content, "test.zip")

        assert result["description"] == "Test skill for debugging"
        assert result["version"] == "1.0.0"
        assert result["author"] == "Test Author"
        assert result["tags"] == ["test", "debug"]
        assert result["file_size"] == len(zip_content)
        assert len(result["file_hash"]) == 64  # SHA256 hex length

    def test_validate_zip_missing_version(self):
        """Test ZIP validation with SKILL.md missing optional fields"""
        skill_md_content = """---
description: "Minimal skill"
---

# Minimal Skill

"""
        zip_content = self.create_test_zip({"SKILL.md": skill_md_content}, "test.zip")

        result = SkillValidator.validate_zip(zip_content, "test.zip")

        assert result["description"] == "Minimal skill"
        assert result["version"] is None
        assert result["author"] is None
        assert result["tags"] is None

    def test_validate_zip_exceeds_size_limit(self):
        """Test validation fails when ZIP exceeds 10MB"""
        # Create a file that will result in a ZIP > 10MB
        # Use binary data that won't compress well
        import os

        large_content = os.urandom(11 * 1024 * 1024)  # 11MB of random bytes

        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(
            zip_buffer, "w", zipfile.ZIP_STORED
        ) as zip_file:  # Use ZIP_STORED (no compression)
            zip_file.writestr("test/SKILL.md", "---\ndescription: test\n---\n")
            zip_file.writestr("test/large_file.bin", large_content)
        zip_content = zip_buffer.getvalue()

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 413
        assert "exceeds maximum allowed size" in exc_info.value.detail

    def test_validate_zip_invalid_format(self):
        """Test validation fails with invalid ZIP file"""
        invalid_zip = b"This is not a ZIP file"

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(invalid_zip, "test.zip")

        assert exc_info.value.status_code == 400
        assert "Invalid ZIP file format" in exc_info.value.detail

    def test_validate_zip_missing_skill_md(self):
        """Test validation fails when SKILL.md is missing"""
        zip_content = self.create_test_zip(
            {"README.md": "This has no SKILL.md"}, "test.zip"
        )

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "SKILL.md not found" in exc_info.value.detail

    def test_validate_zip_skill_md_no_frontmatter(self):
        """Test validation fails when SKILL.md has no YAML frontmatter"""
        skill_md_content = """# Skill Without Frontmatter

This SKILL.md has no YAML frontmatter.
"""
        zip_content = self.create_test_zip({"SKILL.md": skill_md_content}, "test.zip")

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "must contain YAML frontmatter" in exc_info.value.detail

    def test_validate_zip_skill_md_missing_description(self):
        """Test validation fails when description field is missing"""
        skill_md_content = """---
version: "1.0.0"
author: "Test"
---

# Skill

"""
        zip_content = self.create_test_zip({"SKILL.md": skill_md_content}, "test.zip")

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "must include 'description' field" in exc_info.value.detail

    def test_validate_zip_skill_md_invalid_yaml(self):
        """Test validation fails with invalid YAML syntax"""
        skill_md_content = """---
description: "Test"
invalid yaml: [unclosed bracket
---

# Skill

"""
        zip_content = self.create_test_zip({"SKILL.md": skill_md_content}, "test.zip")

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "Invalid YAML frontmatter" in exc_info.value.detail

    def test_validate_zip_prevent_zip_slip(self):
        """Test validation prevents Zip Slip attacks"""
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zip_file:
            # Try to write to parent directory
            zip_file.writestr("../../../etc/passwd", "malicious content")
            zip_file.writestr("SKILL.md", "---\ndescription: test\n---\n")

        zip_content = zip_buffer.getvalue()

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "Unsafe file path detected" in exc_info.value.detail

    def test_validate_zip_prevent_absolute_path(self):
        """Test validation prevents absolute paths in ZIP"""
        zip_buffer = io.BytesIO()
        with zipfile.ZipFile(zip_buffer, "w") as zip_file:
            zip_file.writestr("/etc/passwd", "malicious")
            zip_file.writestr("SKILL.md", "---\ndescription: test\n---\n")

        zip_content = zip_buffer.getvalue()

        with pytest.raises(HTTPException) as exc_info:
            SkillValidator.validate_zip(zip_content, "test.zip")

        assert exc_info.value.status_code == 400
        assert "Unsafe file path detected" in exc_info.value.detail

    def test_validate_zip_skill_md_in_subdirectory(self):
        """Test SKILL.md can be in a subdirectory"""
        skill_md_content = """---
description: "Skill in subdirectory"
version: "2.0.0"
---

# Subdirectory Skill

"""
        zip_content = self.create_test_zip(
            {"my-skill/SKILL.md": skill_md_content, "my-skill/code.py": "# code"},
            "my-skill.zip",
        )

        result = SkillValidator.validate_zip(zip_content, "my-skill.zip")

        assert result["description"] == "Skill in subdirectory"
        assert result["version"] == "2.0.0"

    def test_validate_zip_multiple_skill_md_uses_first(self):
        """Test when multiple SKILL.md exist, the first one is used"""
        skill_md_1 = """---
description: "First skill"
version: "1.0.0"
---

"""
        skill_md_2 = """---
description: "Second skill"
version: "2.0.0"
---

"""
        zip_content = self.create_test_zip(
            {"skill1/SKILL.md": skill_md_1, "skill2/SKILL.md": skill_md_2}, "skill1.zip"
        )

        result = SkillValidator.validate_zip(zip_content, "skill1.zip")

        # Should use the first SKILL.md found
        assert result["description"] in ["First skill", "Second skill"]
        assert result["version"] in ["1.0.0", "2.0.0"]

    def test_validate_zip_unicode_content(self):
        """Test SKILL.md with Unicode content"""
        skill_md_content = """---
description: "技能描述 (Chinese characters)"
author: "作者"
tags: ["测试", "调试"]
---

# Unicode Skill

Support for 中文、日本語、한국어

"""
        zip_content = self.create_test_zip({"SKILL.md": skill_md_content}, "test.zip")

        result = SkillValidator.validate_zip(zip_content, "test.zip")

        assert result["description"] == "技能描述 (Chinese characters)"
        assert result["author"] == "作者"
        assert result["tags"] == ["测试", "调试"]
