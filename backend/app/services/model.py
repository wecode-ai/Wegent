# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Dict, Any
import json

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.model import Model
from app.models.user import User
from app.models.agent import Agent
from app.schemas.model import ModelCreate, ModelUpdate, ModelBulkCreateItem
from app.services.base import BaseService


class ModelService(BaseService[Model, ModelCreate, ModelUpdate]):
    """
    Model service class
    """

    def create_model(self, db: Session, *, obj_in: ModelCreate, current_user: User) -> Model:
        """
        Create a Model entry
        """
        # Ensure unique name (matching DB unique index)
        existed = db.query(Model).filter(Model.name == obj_in.name).first()
        if existed:
            raise HTTPException(status_code=400, detail="Model name already exists")

        db_obj = Model(
            name=obj_in.name,
            config=obj_in.config,
            is_active=obj_in.is_active if obj_in.is_active is not None else True,
        )
        db.add(db_obj)
        db.commit()
        db.refresh(db_obj)
        return db_obj

    def bulk_create_models(self, db: Session, *, items: List[ModelBulkCreateItem], current_user: User) -> Dict[str, Any]:
        """
        Bulk upsert models.
        For each item:
          - If model with the given name exists: update config.env with provided env and update is_active (when provided).
          - If not exists: insert new model with config={'env': env} and is_active.
        Returns:
          {
            "created": [Model, ...],
            "updated": [Model, ...],
            "skipped": [{"name": str, "reason": str}, ...]  # only on DB errors
          }
        """
        created: List[Model] = []
        updated: List[Model] = []
        skipped: List[Dict[str, Any]] = []
        
        for it in items:
            try:
                existed = db.query(Model).filter(Model.name == it.name).first()
                if existed:
                    # Overwrite env section to match request semantics
                    cfg = existed.config if isinstance(existed.config, dict) else {}
                    cfg["env"] = dict(it.env) if isinstance(it.env, dict) else {}
                    existed.config = cfg
                    # Update is_active only if explicitly provided
                    if getattr(it, "is_active", None) is not None:
                        existed.is_active = it.is_active  # type: ignore[attr-defined]
                    db.add(existed)
                    db.commit()
                    db.refresh(existed)
                    updated.append(existed)
                else:
                    # Create new
                    cfg = {"env": it.env}
                    db_obj = Model(
                        name=it.name,
                        config=cfg,
                        is_active=getattr(it, "is_active", True),  # type: ignore[attr-defined]
                    )
                    db.add(db_obj)
                    db.commit()
                    db.refresh(db_obj)
                    created.append(db_obj)
            except Exception as e:
                db.rollback()
                skipped.append({"name": it.name, "reason": f"DB error: {str(e)}"})
        
        return {"created": created, "updated": updated, "skipped": skipped}

    def get_models(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: User
    ) -> List[Model]:
        """
        Get active models (paginated)
        """
        return (
            db.query(Model)
            .filter(Model.is_active == True)  # noqa: E712
            .order_by(Model.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

    def count_active_models(self, db: Session, *, current_user: User) -> int:
        """
        Count active models
        """
        return db.query(Model).filter(Model.is_active == True).count()  # noqa: E712

    def list_model_names(self, db: Session, *, current_user: User, agent_name: str) -> List[Dict[str, str]]:
        """
        List available model names [{'name': str}, ...]
        Simplified logic:
        - Validate if agent_name exists, return 400 if not
        - Read whitelist from agent.config.mode_filter; missing/empty => allow all
        - Whitelist matches Model.config.env.model
        """
        # Validate and retrieve agent configuration
        agent_row = db.query(Agent.id, Agent.config).filter(Agent.name == agent_name).first()
        if not agent_row:
            raise HTTPException(status_code=400, detail="Agent not found")
        _, agent_cfg = agent_row

        # Normalize mode_filter to List[str] or empty (empty means allow all)
        mode_filter: List[str] = []
        if isinstance(agent_cfg, dict):
            mf = agent_cfg.get("mode_filter")
            if isinstance(mf, list):
                mode_filter = [str(x) for x in mf if x]

        allow_all = len(mode_filter) == 0
        models = db.query(Model).filter(Model.is_active == True).all()  # noqa: E712

        if allow_all:
            return [{"name": m.name} for m in models]

        allowed = set(mode_filter)

        def provider(m: Model) -> Optional[str]:
            cfg = getattr(m, "config", None)
            if not isinstance(cfg, dict):
                return None
            env = cfg.get("env")
            if not isinstance(env, dict):
                return None
            return env.get("model")

        return [{"name": m.name} for m in models if (provider(m) in allowed)]

    def get_by_id(self, db: Session, *, model_id: int, current_user: User) -> Optional[Model]:
        """
        Get model by ID (only active)
        """
        model = (
            db.query(Model)
            .filter(Model.id == model_id, Model.is_active == True)  # noqa: E712
            .first()
        )
        if not model:
            raise HTTPException(status_code=404, detail="Model not found")
        return model

    def update_model(
        self, db: Session, *, model_id: int, obj_in: ModelUpdate, current_user:User
    ) -> Model:
        """
        Update model by ID
        """
        model = self.get_by_id(db, model_id=model_id)

        update_data = obj_in.model_dump(exclude_unset=True)

        # If updating name, ensure uniqueness
        if "name" in update_data and update_data["name"] != model.name:
            existed = db.query(Model).filter(Model.name == update_data["name"]).first()
            if existed:
                raise HTTPException(status_code=400, detail="Model name already exists")

        for field, value in update_data.items():
            setattr(model, field, value)

        db.add(model)
        db.commit()
        db.refresh(model)
        return model

    def delete_model(self, db: Session, *, model_id: int, current_user: User) -> None:
        """
        Soft delete model by setting is_active to False
        """
        model = self.get_by_id(db, model_id=model_id)
        db.delete(model)
        db.commit()


model_service = ModelService(Model)