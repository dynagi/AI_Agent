"""Research search via the arXiv API — free, no key required. Good
default source for literature discovery; a keyed provider (Semantic
Scholar, etc.) can be added behind the same shape later."""
from __future__ import annotations

from xml.etree import ElementTree

import httpx
from pydantic import BaseModel

ATOM_NS = "{http://www.w3.org/2005/Atom}"


class ResearchServiceError(Exception):
    pass


class ResearchPaper(BaseModel):
    title: str
    summary: str
    authors: list[str]
    link: str
    published: str


async def search_papers(query: str, *, max_results: int = 10) -> list[ResearchPaper]:
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(
            "https://export.arxiv.org/api/query",
            params={"search_query": f"all:{query}", "start": 0, "max_results": max_results},
        )
    if resp.status_code >= 400:
        raise ResearchServiceError(f"arXiv request failed ({resp.status_code}): {resp.text}")

    root = ElementTree.fromstring(resp.text)
    papers: list[ResearchPaper] = []
    for entry in root.findall(f"{ATOM_NS}entry"):
        title = (entry.findtext(f"{ATOM_NS}title") or "").strip()
        summary = (entry.findtext(f"{ATOM_NS}summary") or "").strip()
        published = (entry.findtext(f"{ATOM_NS}published") or "").strip()
        link = ""
        for link_el in entry.findall(f"{ATOM_NS}link"):
            if link_el.get("type") == "text/html":
                link = link_el.get("href", "")
                break
        authors = [
            (a.findtext(f"{ATOM_NS}name") or "").strip() for a in entry.findall(f"{ATOM_NS}author")
        ]
        papers.append(ResearchPaper(title=title, summary=summary, authors=authors, link=link, published=published))

    return papers
