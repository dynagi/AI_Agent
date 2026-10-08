from __future__ import annotations

from contextlib import asynccontextmanager

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.routers import ai, companion, research, screen, shopping, travel, voice
from app.services import data_sync
from app.services import recommendation_service as reco

logger = structlog.get_logger()

scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(_: FastAPI):
    async def _train_job():
        for domain in ("shopping", "travel"):
            try:
                await reco.train_model(domain)
            except Exception:
                logger.exception("interest_model.train.failed", domain=domain)

    # Retrain on startup (picks up anything accumulated since the last
    # restart) and once every day after that, per "train the model on
    # interested/not-interested feedback every day" — for every domain.
    scheduler.add_job(_train_job, "interval", days=1, next_run_time=None, id="train_interest_model")
    if data_sync.enabled():
        # no permanent disk (Render free): copy changed learned files to Supabase every few minutes
        scheduler.add_job(_sync_job, "interval", minutes=3, id="data_sync")
    scheduler.start()
    await _train_job()
    yield
    scheduler.shutdown(wait=False)
    await _sync_job()   # last copy before the host stops the service


async def _sync_job():
    import asyncio
    try:
        await asyncio.to_thread(data_sync.sync_changed)
    except Exception:
        logger.exception("data_sync.failed")


app = FastAPI(title="AURA AI Service", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4000", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ai.router)
app.include_router(companion.router)
app.include_router(voice.router)
app.include_router(shopping.router)
app.include_router(screen.router)
app.include_router(travel.router)
app.include_router(research.router)


@app.get("/")
async def root():
    return {"service": "aura-python-ai", "status": "running", "environment": settings.environment}
