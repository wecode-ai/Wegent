# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from typing import List, Dict, Any
from fastapi import APIRouter, Depends, HTTPException, Query, Path
from sqlalchemy.orm import Session
from wecode.service.model_service import (
    list_model_names as svc_list_model_names,
    list_models as svc_list_models,
    create_model as svc_create_model,
    update_model as svc_update_model,
    delete_model as svc_delete_model,
)

from app.api.dependencies import get_db
from app.core import security
from app.models.user import User
from wecode.schemas.model import ModelCreate, ModelUpdate, ModelOut

router = APIRouter()

def _ensure_admin(current_user: User):
    if not current_user or current_user.user_name != "admin":
        raise HTTPException(status_code=403, detail="仅管理员可访问")


@router.get("/names", response_model=List[str], summary="获取模型名字列表")
def list_model_names(
    db: Session = Depends(get_db),
) -> List[str]:
    try:
        return svc_list_model_names(db)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询模型名称失败: {str(e)}")


@router.get("", response_model=List[ModelOut], summary="获取所有模型")
def list_models(
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> List[ModelOut]:
    _ensure_admin(current_user)
    try:
        data = svc_list_models(db)
        return [ModelOut(**d) for d in data]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"查询模型列表失败: {str(e)}")

@router.post("", response_model=ModelOut, summary="新增模型")
def create_model(
    payload: ModelCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> ModelOut:
    _ensure_admin(current_user)
    try:
        data = svc_create_model(db, name=payload.name, config=payload.config)
        return ModelOut(**data)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"创建模型失败: {str(e)}")


@router.put("/{model_id}", response_model=ModelOut, summary="修改模型")
def update_model(
    model_id: int = Path(..., description="模型ID"),
    payload: ModelUpdate = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> ModelOut:
    _ensure_admin(current_user)
    try:
        data = svc_update_model(
            db,
            model_id=model_id,
            name=payload.name if payload else None,
            config=payload.config if payload else None,
            is_active=payload.is_active if payload else None,
        )
        return ModelOut(**data)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"更新模型失败: {str(e)}")


@router.delete("/{model_id}", summary="删除模型")
def delete_model(
    model_id: int = Path(..., description="模型ID"),
    db: Session = Depends(get_db),
    current_user: User = Depends(security.get_current_user)
) -> Dict[str, Any]:
    _ensure_admin(current_user)
    try:
        return svc_delete_model(db, model_id=model_id)
    except KeyError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"删除模型失败: {str(e)}")
