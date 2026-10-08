from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from app.services.research_service import ResearchPaper, ResearchServiceError, search_papers

router = APIRouter(prefix="/ai/research", tags=["research"])


@router.get("/search", response_model=list[ResearchPaper])
async def search(q: str = Query(..., min_length=1), max_results: int = Query(10, ge=1, le=30)):
    try:
        return await search_papers(q, max_results=max_results)
    except ResearchServiceError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
