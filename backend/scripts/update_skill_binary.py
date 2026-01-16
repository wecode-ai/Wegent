#!/usr/bin/env python3
"""
Script to update a skill's binary data from the init_data/skills directory.

Usage:
    cd backend
    python scripts/update_skill_binary.py mermaid-diagram

This will:
1. Find the skill by name in the database
2. Repackage the skill folder into a ZIP
3. Update the SkillBinary record
"""

import io
import os
import sys
import zipfile
from pathlib import Path

# Add backend to path
backend_dir = Path(__file__).parent.parent
sys.path.insert(0, str(backend_dir))

os.chdir(backend_dir)

from dotenv import load_dotenv

load_dotenv()

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.skill_binary import SkillBinary


def create_skill_zip(skill_folder: Path) -> bytes:
    """Create a ZIP file from a skill folder.

    The ZIP structure must be: skill_name/file.py
    This is required by SkillToolRegistry.load_provider_from_zip which expects
    files to be in a subdirectory (len(parts) == 2).
    """
    buffer = io.BytesIO()
    skill_name = skill_folder.name  # e.g., "mermaid-diagram"
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in skill_folder.rglob("*"):
            if file_path.is_file():
                # Skip __pycache__ and .pyc files
                if "__pycache__" in str(file_path) or file_path.suffix == ".pyc":
                    continue
                # Create path like: mermaid-diagram/provider.py
                relative_path = file_path.relative_to(skill_folder)
                arcname = f"{skill_name}/{relative_path}"
                zf.write(file_path, arcname)
    return buffer.getvalue()


def update_skill_binary(db: Session, skill_name: str, skill_folder: Path) -> bool:
    """Update skill binary in database."""
    # Find the skill (public skills have user_id=0)
    skill = (
        db.query(Kind)
        .filter(
            Kind.user_id == 0,
            Kind.kind == "Skill",
            Kind.name == skill_name,
            Kind.is_active == True,
        )
        .first()
    )

    if not skill:
        print(f"Error: Skill '{skill_name}' not found in database")
        return False

    print(f"Found skill: id={skill.id}, name={skill.name}")

    # Create ZIP from folder
    zip_data = create_skill_zip(skill_folder)
    print(f"Created ZIP: {len(zip_data)} bytes")

    # Update or create SkillBinary
    skill_binary = db.query(SkillBinary).filter(SkillBinary.kind_id == skill.id).first()

    if skill_binary:
        skill_binary.binary_data = zip_data
        skill_binary.file_size = len(zip_data)
        print(f"Updated existing SkillBinary record")
    else:
        skill_binary = SkillBinary(
            kind_id=skill.id,
            binary_data=zip_data,
            file_size=len(zip_data),
        )
        db.add(skill_binary)
        print(f"Created new SkillBinary record")

    db.commit()
    print(f"Successfully updated skill binary for '{skill_name}'")
    return True


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/update_skill_binary.py <skill_name>")
        print("Example: python scripts/update_skill_binary.py mermaid-diagram")
        sys.exit(1)

    skill_name = sys.argv[1]
    skill_folder = backend_dir / "init_data" / "skills" / skill_name

    if not skill_folder.exists():
        print(f"Error: Skill folder not found: {skill_folder}")
        sys.exit(1)

    print(f"Updating skill: {skill_name}")
    print(f"From folder: {skill_folder}")

    db = SessionLocal()
    try:
        success = update_skill_binary(db, skill_name, skill_folder)
        sys.exit(0 if success else 1)
    finally:
        db.close()


if __name__ == "__main__":
    main()
