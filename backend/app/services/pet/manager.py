# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Pet service manager for handling pet business logic using Kind table."""

import logging
import math
import re
import secrets
from collections import Counter
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from sqlalchemy import and_
from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

from app.models.kind import Kind

logger = logging.getLogger(__name__)
from app.schemas.pet import (
    DOMAIN_APPEARANCE_MAP,
    PetResponse,
    PetUpdate,
)

# Domain detection keywords
# Each domain has a list of keywords that indicate the user is working in that domain
DOMAIN_KEYWORDS = {
    "tech": [
        # Programming languages
        "python",
        "javascript",
        "typescript",
        "java",
        "c++",
        "rust",
        "go",
        "golang",
        "ruby",
        "php",
        "swift",
        "kotlin",
        "scala",
        "haskell",
        "erlang",
        "elixir",
        # Frameworks and tools
        "react",
        "vue",
        "angular",
        "django",
        "flask",
        "fastapi",
        "spring",
        "node",
        "docker",
        "kubernetes",
        "k8s",
        "aws",
        "azure",
        "gcp",
        "terraform",
        # Concepts
        "api",
        "database",
        "sql",
        "nosql",
        "mongodb",
        "redis",
        "postgresql",
        "mysql",
        "git",
        "github",
        "gitlab",
        "ci/cd",
        "devops",
        "microservice",
        "backend",
        "frontend",
        "fullstack",
        "algorithm",
        "data structure",
        "machine learning",
        "deep learning",
        "neural network",
        "ai",
        "artificial intelligence",
        "code",
        "programming",
        "software",
        "developer",
        "engineer",
        "debug",
        "deploy",
        "server",
        "cloud",
        "linux",
        "unix",
        "shell",
        "bash",
        # Chinese keywords
        "编程",
        "代码",
        "开发",
        "软件",
        "算法",
        "数据库",
        "服务器",
        "部署",
        "前端",
        "后端",
        "全栈",
        "人工智能",
        "机器学习",
        "深度学习",
    ],
    "legal": [
        # Legal terms
        "law",
        "legal",
        "lawyer",
        "attorney",
        "court",
        "judge",
        "litigation",
        "contract",
        "agreement",
        "clause",
        "liability",
        "damages",
        "plaintiff",
        "defendant",
        "jurisdiction",
        "statute",
        "regulation",
        "compliance",
        "intellectual property",
        "patent",
        "trademark",
        "copyright",
        "license",
        "tort",
        "criminal",
        "civil",
        "arbitration",
        "mediation",
        "settlement",
        # Chinese keywords
        "法律",
        "律师",
        "法院",
        "合同",
        "协议",
        "诉讼",
        "仲裁",
        "知识产权",
        "专利",
        "商标",
        "版权",
        "侵权",
        "赔偿",
        "法规",
        "条款",
        "被告",
        "原告",
    ],
    "finance": [
        # Finance terms
        "finance",
        "financial",
        "investment",
        "stock",
        "bond",
        "equity",
        "fund",
        "portfolio",
        "asset",
        "liability",
        "balance sheet",
        "income statement",
        "cash flow",
        "roi",
        "return",
        "dividend",
        "interest",
        "loan",
        "mortgage",
        "bank",
        "banking",
        "trading",
        "forex",
        "cryptocurrency",
        "bitcoin",
        "accounting",
        "audit",
        "tax",
        "budget",
        "revenue",
        "profit",
        "loss",
        # Chinese keywords
        "金融",
        "投资",
        "股票",
        "债券",
        "基金",
        "资产",
        "负债",
        "财务",
        "会计",
        "审计",
        "税务",
        "预算",
        "收入",
        "利润",
        "银行",
        "贷款",
    ],
    "medical": [
        # Medical terms
        "medical",
        "medicine",
        "doctor",
        "physician",
        "nurse",
        "hospital",
        "clinic",
        "patient",
        "diagnosis",
        "treatment",
        "therapy",
        "surgery",
        "prescription",
        "drug",
        "medication",
        "symptom",
        "disease",
        "illness",
        "health",
        "healthcare",
        "anatomy",
        "physiology",
        "pathology",
        "radiology",
        "cardiology",
        "neurology",
        "oncology",
        "pediatrics",
        "psychiatry",
        "pharmacy",
        "vaccine",
        "clinical",
        # Chinese keywords
        "医学",
        "医疗",
        "医生",
        "护士",
        "医院",
        "诊所",
        "患者",
        "诊断",
        "治疗",
        "手术",
        "处方",
        "药物",
        "症状",
        "疾病",
        "健康",
        "临床",
    ],
    "design": [
        # Design terms
        "design",
        "designer",
        "ui",
        "ux",
        "user interface",
        "user experience",
        "graphic",
        "visual",
        "illustration",
        "typography",
        "color",
        "layout",
        "wireframe",
        "prototype",
        "mockup",
        "figma",
        "sketch",
        "adobe",
        "photoshop",
        "illustrator",
        "indesign",
        "creative",
        "art",
        "artistic",
        "aesthetic",
        "brand",
        "branding",
        "logo",
        "icon",
        "animation",
        "motion",
        "3d",
        # Chinese keywords
        "设计",
        "设计师",
        "用户界面",
        "用户体验",
        "图形",
        "视觉",
        "插画",
        "排版",
        "配色",
        "原型",
        "品牌",
        "标志",
        "图标",
        "动画",
        "创意",
    ],
    "education": [
        # Education terms
        "education",
        "educational",
        "teacher",
        "student",
        "school",
        "university",
        "college",
        "course",
        "curriculum",
        "lesson",
        "lecture",
        "exam",
        "test",
        "grade",
        "degree",
        "diploma",
        "certificate",
        "learning",
        "teaching",
        "pedagogy",
        "academic",
        "research",
        "thesis",
        "dissertation",
        "professor",
        "tutor",
        "mentor",
        "classroom",
        "online learning",
        "e-learning",
        # Chinese keywords
        "教育",
        "教学",
        "老师",
        "学生",
        "学校",
        "大学",
        "课程",
        "考试",
        "学习",
        "研究",
        "论文",
        "学位",
        "教授",
        "导师",
        "课堂",
        "在线学习",
    ],
}

# Pet CRD constants
PET_KIND = "Pet"
PET_NAME = "my-pet"  # Fixed name since each user has only one pet
PET_NAMESPACE = "default"


class PetService:
    """Service class for pet operations using Kind table."""

    # Experience gain amounts
    EXP_PER_CHAT = 1

    # Stage thresholds
    STAGE_THRESHOLDS = {
        1: 0,  # Baby: 0-99
        2: 100,  # Growing: 100-499
        3: 500,  # Mature: 500+
    }

    def _generate_svg_seed(self) -> str:
        """Generate a random SVG seed for consistent pet appearance."""
        return secrets.token_hex(32)

    def _calculate_stage(self, experience: int) -> int:
        """Calculate the evolution stage based on experience."""
        if experience >= self.STAGE_THRESHOLDS[3]:
            return 3
        elif experience >= self.STAGE_THRESHOLDS[2]:
            return 2
        return 1

    def _get_experience_to_next_stage(
        self, experience: int, stage: int
    ) -> Optional[int]:
        """Calculate experience needed for next stage."""
        if stage >= 3:
            return None  # Already at max stage
        next_threshold = self.STAGE_THRESHOLDS.get(stage + 1, None)
        if next_threshold is None:
            return None
        return max(0, next_threshold - experience)

    def _get_streak_multiplier(self, current_streak: int) -> float:
        """Get the experience multiplier based on current streak."""
        if current_streak >= 30:
            return 1.5
        elif current_streak >= 7:
            return 1.2
        elif current_streak >= 3:
            return 1.1
        return 1.0

    def _update_streak(self, spec: Dict[str, Any], today: date) -> Tuple[int, bool]:
        """
        Update the streak based on last active date.

        Returns:
            Tuple of (new_streak, is_new_day)
        """
        last_active_str = spec.get("lastActiveDate")
        if last_active_str is None:
            # First activity
            return 1, True

        last_active_date = date.fromisoformat(last_active_str)
        days_diff = (today - last_active_date).days

        if days_diff == 0:
            # Same day, no change
            return spec.get("currentStreak", 0), False
        elif days_diff == 1:
            # Consecutive day
            return spec.get("currentStreak", 0) + 1, True
        else:
            # Streak broken
            return 1, True

    def _build_pet_spec(
        self,
        pet_name: str = "Wegi",
        stage: int = 1,
        experience: int = 0,
        total_chats: int = 0,
        current_streak: int = 0,
        longest_streak: int = 0,
        last_active_date: Optional[date] = None,
        appearance_traits: Optional[Dict[str, Any]] = None,
        svg_seed: Optional[str] = None,
        is_visible: bool = True,
    ) -> Dict[str, Any]:
        """Build the spec portion of the Pet CRD."""
        if appearance_traits is None:
            appearance_traits = {
                "primary_domain": "general",
                "secondary_domain": None,
                "color_tone": "gray",
                "accessories": [],
            }
        if svg_seed is None:
            svg_seed = self._generate_svg_seed()

        return {
            "petName": pet_name,
            "stage": stage,
            "experience": experience,
            "totalChats": total_chats,
            "currentStreak": current_streak,
            "longestStreak": longest_streak,
            "lastActiveDate": (
                last_active_date.isoformat() if last_active_date else None
            ),
            "appearanceTraits": appearance_traits,
            "svgSeed": svg_seed,
            "isVisible": is_visible,
        }

    def _build_pet_resource(self, spec: Dict[str, Any]) -> Dict[str, Any]:
        """Build the full Pet CRD resource."""
        return {
            "apiVersion": "agent.wecode.io/v1",
            "kind": PET_KIND,
            "metadata": {
                "name": PET_NAME,
                "namespace": PET_NAMESPACE,
            },
            "spec": spec,
            "status": {
                "state": "Available",
            },
        }

    def _get_pet_kind(self, db: Session, user_id: int) -> Optional[Kind]:
        """Get the Pet Kind record for a user."""
        return (
            db.query(Kind)
            .filter(
                and_(
                    Kind.user_id == user_id,
                    Kind.kind == PET_KIND,
                    Kind.name == PET_NAME,
                    Kind.namespace == PET_NAMESPACE,
                    Kind.is_active == True,
                )
            )
            .first()
        )

    def _spec_from_kind(self, kind: Kind) -> Dict[str, Any]:
        """Extract spec from Kind record."""
        return kind.json.get("spec", {})

    def get_pet(self, db: Session, user_id: int) -> Optional[Kind]:
        """Get a user's pet Kind record."""
        return self._get_pet_kind(db, user_id)

    def get_or_create_pet(self, db: Session, user_id: int) -> Kind:
        """Get existing pet or create a new one for the user."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            pet = self.create_pet(db, user_id)
        return pet

    def create_pet(self, db: Session, user_id: int, pet_name: str = "Wegi") -> Kind:
        """Create a new pet for a user."""
        spec = self._build_pet_spec(pet_name=pet_name)
        resource = self._build_pet_resource(spec)

        pet = Kind(
            user_id=user_id,
            kind=PET_KIND,
            name=PET_NAME,
            namespace=PET_NAMESPACE,
            json=resource,
            is_active=True,
        )
        db.add(pet)
        db.commit()
        db.refresh(pet)
        return pet

    def update_pet(
        self, db: Session, user_id: int, pet_update: PetUpdate
    ) -> Optional[Kind]:
        """Update a user's pet settings."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return None

        spec = self._spec_from_kind(pet)
        update_data = pet_update.model_dump(exclude_unset=True)

        # Map schema fields to spec fields
        field_mapping = {
            "pet_name": "petName",
            "is_visible": "isVisible",
        }

        for schema_field, value in update_data.items():
            spec_field = field_mapping.get(schema_field, schema_field)
            spec[spec_field] = value

        # Update the resource
        resource = pet.json.copy()
        resource["spec"] = spec
        pet.json = resource
        pet.updated_at = datetime.now()

        db.commit()
        db.refresh(pet)
        return pet

    def reset_pet(self, db: Session, user_id: int) -> Kind:
        """Reset a user's pet to initial state with new seed."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return self.create_pet(db, user_id)

        # Get current visibility preference
        spec = self._spec_from_kind(pet)
        is_visible = spec.get("isVisible", True)

        # Reset all stats but keep visibility preference
        new_spec = self._build_pet_spec(is_visible=is_visible)
        resource = self._build_pet_resource(new_spec)

        pet.json = resource
        pet.updated_at = datetime.now()

        db.commit()
        db.refresh(pet)
        return pet

    def add_chat_experience(self, db: Session, user_id: int) -> Tuple[Kind, int, bool]:
        """
        Add experience for sending a chat message.

        Returns:
            Tuple of (pet, exp_gained, evolved)
        """
        pet = self.get_or_create_pet(db, user_id)
        spec = self._spec_from_kind(pet)
        today = date.today()

        logger.info(
            "[PET] add_chat_experience: user_id=%d, current_exp=%d",
            user_id,
            spec.get("experience", 0),
        )

        # Update streak
        new_streak, is_new_day = self._update_streak(spec, today)
        if is_new_day:
            spec["currentStreak"] = new_streak
            spec["lastActiveDate"] = today.isoformat()
            if new_streak > spec.get("longestStreak", 0):
                spec["longestStreak"] = new_streak

        # Calculate experience with multiplier
        multiplier = self._get_streak_multiplier(spec.get("currentStreak", 0))
        exp_gained = math.ceil(self.EXP_PER_CHAT * multiplier)

        # Update stats
        spec["totalChats"] = spec.get("totalChats", 0) + 1
        old_stage = spec.get("stage", 1)
        spec["experience"] = spec.get("experience", 0) + exp_gained
        spec["stage"] = self._calculate_stage(spec["experience"])
        evolved = spec["stage"] > old_stage

        logger.info(
            "[PET] add_chat_experience: user_id=%d, new_exp=%d, exp_gained=%d",
            user_id,
            spec["experience"],
            exp_gained,
        )

        # Save changes - use flag_modified to ensure SQLAlchemy detects JSON changes
        resource = pet.json.copy()
        resource["spec"] = spec
        pet.json = resource
        flag_modified(pet, "json")
        pet.updated_at = datetime.now()

        db.commit()
        db.refresh(pet)

        # Verify the update
        updated_spec = pet.json.get("spec", {})
        logger.info(
            "[PET] add_chat_experience after commit: user_id=%d, exp_in_db=%d",
            user_id,
            updated_spec.get("experience", 0),
        )

        return pet, exp_gained, evolved

    def update_appearance_traits(
        self, db: Session, user_id: int, traits: Dict[str, Any]
    ) -> Optional[Kind]:
        """Update a pet's appearance traits based on memory analysis."""
        pet = self.get_pet(db, user_id)
        if pet is None:
            return None

        spec = self._spec_from_kind(pet)

        # Merge with existing traits
        current_traits = dict(spec.get("appearanceTraits", {}))
        current_traits.update(traits)

        # Apply domain-specific appearance if primary_domain changed
        primary_domain = current_traits.get("primary_domain", "general")
        if primary_domain in DOMAIN_APPEARANCE_MAP:
            domain_appearance = DOMAIN_APPEARANCE_MAP[primary_domain]
            current_traits["color_tone"] = domain_appearance["color_tone"]
            current_traits["accessories"] = domain_appearance["accessories"]

        spec["appearanceTraits"] = current_traits

        # Save changes
        resource = pet.json.copy()
        resource["spec"] = spec
        pet.json = resource
        pet.updated_at = datetime.now()

        db.commit()
        db.refresh(pet)
        return pet

    def detect_domain_from_text(self, text: str) -> Tuple[Optional[str], Optional[str]]:
        """
        Detect the primary and secondary domain from text content.

        Uses keyword matching to identify which domain the text belongs to.
        Returns the top two domains if they have significant keyword matches.

        Args:
            text: Text content to analyze (e.g., memory content, chat messages)

        Returns:
            Tuple of (primary_domain, secondary_domain)
            - primary_domain: The domain with the most keyword matches, or None if no matches
            - secondary_domain: The domain with the second most matches, or None
        """
        if not text:
            return None, None

        # Normalize text for matching
        text_lower = text.lower()

        # Count keyword matches for each domain
        domain_scores: Counter = Counter()

        for domain, keywords in DOMAIN_KEYWORDS.items():
            for keyword in keywords:
                # Use word boundary matching for English keywords
                # For Chinese keywords, use simple substring matching
                if re.search(r"[\u4e00-\u9fff]", keyword):
                    # Chinese keyword - simple substring match
                    if keyword in text_lower:
                        domain_scores[domain] += 1
                else:
                    # English keyword - word boundary match
                    pattern = r"\b" + re.escape(keyword) + r"\b"
                    matches = len(re.findall(pattern, text_lower, re.IGNORECASE))
                    domain_scores[domain] += matches

        # Get top two domains
        top_domains = domain_scores.most_common(2)

        primary_domain = None
        secondary_domain = None

        # Only consider domains with at least 2 keyword matches
        if top_domains and top_domains[0][1] >= 2:
            primary_domain = top_domains[0][0]

            # Secondary domain needs at least 1 match and be at least 30% of primary
            if len(top_domains) > 1 and top_domains[1][1] >= 1:
                if top_domains[1][1] >= top_domains[0][1] * 0.3:
                    secondary_domain = top_domains[1][0]

        return primary_domain, secondary_domain

    def update_domain_from_memories(
        self, db: Session, user_id: int, memory_texts: List[str]
    ) -> Tuple[Optional[Kind], bool]:
        """
        Analyze memory texts and update pet's domain if changed.

        This method:
        1. Combines all memory texts
        2. Detects the primary and secondary domains
        3. Updates the pet's appearance traits if the domain changed

        Args:
            db: Database session
            user_id: User ID
            memory_texts: List of memory text contents to analyze

        Returns:
            Tuple of (updated_pet, domain_changed)
            - updated_pet: The updated pet Kind, or None if no pet exists
            - domain_changed: True if the domain was updated
        """
        if not memory_texts:
            return None, False

        # Combine all memory texts for analysis
        combined_text = " ".join(memory_texts)

        # Detect domains
        primary_domain, secondary_domain = self.detect_domain_from_text(combined_text)

        # If no domain detected, don't update
        if primary_domain is None:
            return None, False

        # Get current pet and check if domain changed
        pet = self.get_pet(db, user_id)
        if pet is None:
            return None, False

        spec = self._spec_from_kind(pet)
        current_traits = spec.get("appearanceTraits", {})
        current_primary = current_traits.get("primary_domain", "general")

        # Only update if primary domain changed
        if primary_domain == current_primary:
            return pet, False

        # Update traits with new domains
        new_traits = {
            "primary_domain": primary_domain,
            "secondary_domain": secondary_domain,
        }

        updated_pet = self.update_appearance_traits(db, user_id, new_traits)
        return updated_pet, True

    def to_response(self, pet: Kind) -> PetResponse:
        """Convert a Pet Kind record to a PetResponse schema."""
        spec = self._spec_from_kind(pet)

        # Parse last_active_date
        last_active_str = spec.get("lastActiveDate")
        last_active_date = None
        if last_active_str:
            last_active_date = date.fromisoformat(last_active_str)

        experience = spec.get("experience", 0)
        stage = spec.get("stage", 1)
        current_streak = spec.get("currentStreak", 0)

        return PetResponse(
            id=pet.id,
            user_id=pet.user_id,
            pet_name=spec.get("petName", "Wegi"),
            stage=stage,
            experience=experience,
            total_chats=spec.get("totalChats", 0),
            current_streak=current_streak,
            longest_streak=spec.get("longestStreak", 0),
            last_active_date=last_active_date,
            appearance_traits=spec.get("appearanceTraits", {}),
            svg_seed=spec.get("svgSeed", ""),
            is_visible=spec.get("isVisible", True),
            experience_to_next_stage=self._get_experience_to_next_stage(
                experience, stage
            ),
            streak_multiplier=self._get_streak_multiplier(current_streak),
            created_at=pet.created_at,
            updated_at=pet.updated_at,
        )


# Global service instance
pet_service = PetService()
