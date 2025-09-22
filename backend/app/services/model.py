# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Optional, Dict

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.model import Model
from app.models.user import User
from app.schemas.model import ModelCreate, ModelUpdate
from app.services.base import BaseService


class ModelService(BaseService[Model, ModelCreate, ModelUpdate]):
    """
    Model service class
    """

    def create_model(self, db: Session, *, obj_in: ModelCreate, current_user: Optional[User] = None) -> Model:
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

    def get_models(
        self, db: Session, *, skip: int = 0, limit: int = 100, current_user: Optional[User] = None
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

    def count_active_models(self, db: Session, *, current_user: Optional[User] = None) -> int:
        """
        Count active models
        """
        return db.query(Model).filter(Model.is_active == True).count()  # noqa: E712

    def list_model_names(self, db: Session, *, current_user: Optional[User] = None, agent_name: str) -> List[Dict[str, str]]:
        """
        List all active model names as [{'name': str}, ...]
        """
        rows = db.query(Model.name).filter(Model.is_active == True).all()  # noqa: E712
        return [{"name": r[0]} for r in rows]

    def get_by_id(self, db: Session, *, model_id: int, current_user: Optional[User] = None) -> Optional[Model]:
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
        self, db: Session, *, model_id: int, obj_in: ModelUpdate, current_user: Optional[User] = None
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

    def delete_model(self, db: Session, *, model_id: int, current_user: Optional[User] = None) -> None:
        """
        Soft delete model by setting is_active to False
        """
        model = self.get_by_id(db, model_id=model_id)
        model.is_active = False
        db.add(model)
        db.commit()


model_service = ModelService(Model)