"""
Reports API endpoints.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_db
from app.schemas.report import WeeklyReportRequest, WeeklyReportResponse
from app.services.report_service import ReportService

router = APIRouter()


@router.post("/weekly", response_model=WeeklyReportResponse)
async def generate_weekly_report(
    request: WeeklyReportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Generate a weekly report for the specified version."""
    service = ReportService(db)
    try:
        result = await service.generate_weekly_report(version_id=request.version_id)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate report: {str(e)}")

    return WeeklyReportResponse(**result)
