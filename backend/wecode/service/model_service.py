# SPDX-License-Identifier: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import Any, Dict, List, Optional
from sqlalchemy.orm import Session

from wecode.models.model import Model


def list_model_names(db: Session) -> List[str]:
    query = db.query(Model.name).filter(Model.is_active.is_(True))
    query = query.order_by(Model.name.asc())
    rows = query.all()
    return [r[0] for r in rows]


def list_models(db: Session) -> List[Dict[str, Any]]:
    query = db.query(Model).filter(Model.is_active.is_(True))
    query = query.order_by(Model.id.asc())
    objs = query.all()
    return [_to_dict(o) for o in objs]


def create_model(db: Session, name: str, config: Dict[str, Any]) -> Dict[str, Any]:
    # 唯一性检查
    exists = db.query(Model).filter(Model.name == name).first()
    if exists:
        raise ValueError("模型名称已存在")

    obj = Model(name=name, config=config, is_active=True)
    db.add(obj)
    db.commit()
    db.refresh(obj)

    return _to_dict(obj)


def update_model(
    db: Session,
    model_id: int,
    name: Optional[str] = None,
    config: Optional[Dict[str, Any]] = None,
    is_active: Optional[bool] = None,
) -> Dict[str, Any]:
    obj = db.query(Model).filter(Model.id == model_id).first()
    if not obj:
        raise KeyError("模型不存在")

    if name is not None:
        # 检查命名冲突
        conflict = db.query(Model).filter(Model.name == name, Model.id != model_id).first()
        if conflict:
            raise ValueError("新的模型名称已被占用")
        obj.name = name

    if config is not None:
        obj.config = config

    if is_active is not None:
        obj.is_active = bool(is_active)

    db.commit()
    db.refresh(obj)
    return _to_dict(obj)


def delete_model(db: Session, model_id: int) -> Dict[str, Any]:
    obj = db.query(Model).filter(Model.id == model_id).first()
    if not obj:
        raise KeyError("模型不存在")
    
    db.delete(obj)
    db.commit()
    return {"success": True, "id": model_id}


def _to_dict(obj: Model) -> Dict[str, Any]:
    return {
        "id": obj.id,
        "name": obj.name,
        "config": obj.config,
        "is_active": bool(obj.is_active),
    }