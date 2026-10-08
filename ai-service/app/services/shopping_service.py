"""Shopping price comparison via SerpAPI's Google Shopping engine, which
aggregates listings across many retailers in one call. Per-retailer APIs
(Amazon PA-API, Flipkart Affiliate, etc.) each require an individually
approved partner account — SerpAPI is the realistic single integration
for genuine cross-platform comparison without those approvals."""
from __future__ import annotations

import re

import httpx
from pydantic import BaseModel

from app.core.config import settings


class ShoppingServiceError(Exception):
    pass


class ShoppingResult(BaseModel):
    title: str
    price: float | None
    currency: str = "INR"
    source: str  # retailer/platform name
    link: str
    thumbnail: str | None = None
    rating: float | None = None
    reviews: int | None = None


_PRICE_RE = re.compile(r"[\d,]+\.?\d*")


def _parse_price(raw: str | None) -> float | None:
    if not raw:
        return None
    match = _PRICE_RE.search(raw.replace(",", ""))
    return float(match.group()) if match else None


async def search_products(query: str, *, max_results: int = 20) -> list[ShoppingResult]:
    if not settings.serpapi_api_key:
        raise ShoppingServiceError("SERPAPI_API_KEY is not configured.")

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.get(
            "https://serpapi.com/search",
            params={
                "engine": "google_shopping",
                "q": query,
                "api_key": settings.serpapi_api_key,
                "num": max_results,
                "gl": settings.default_country,
                "hl": "en",
            },
        )
    if resp.status_code >= 400:
        raise ShoppingServiceError(f"SerpAPI request failed ({resp.status_code}): {resp.text}")

    data = resp.json()
    items = data.get("shopping_results", [])

    results: list[ShoppingResult] = []
    for item in items:
        price = item.get("extracted_price")
        if price is None:
            price = _parse_price(item.get("price"))
        results.append(
            ShoppingResult(
                title=item.get("title", "Unknown product"),
                price=price,
                currency=settings.default_currency,
                source=item.get("source", "Unknown retailer"),
                link=item.get("product_link") or item.get("link") or "",
                thumbnail=item.get("thumbnail"),
                rating=item.get("rating"),
                reviews=item.get("reviews"),
            )
        )

    # Lowest price first; items with no parseable price sink to the bottom.
    results.sort(key=lambda r: (r.price is None, r.price if r.price is not None else float("inf")))
    return results
