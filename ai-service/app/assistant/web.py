"""Searching the web and opening websites on request, from real search results (Google via SerpAPI) — never from
URLs the model makes up.

  "search for the latest AI news"        -> news results, summarised from their own snippets, sources named
  "find the official website for Zerodha" -> the matching official result, then "Shall I open it?"
  "open the documentation for pandas"     -> the same, opened straight away (the user said "open")
  "open wikipedia"                        -> a well-known site directly, else the official result
  "restaurants near me"                   -> Google Maps search, which uses the phone's own location

Opening happens on the phone (an "open_url" action). Apps ("open YouTube", "play X on YouTube") are handled on the
phone itself before anything reaches here."""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from urllib.parse import quote_plus, urlparse

import structlog

from app.assistant import links as L
from app.services import travel_service
from app.services.llm_service import LLMServiceError, llm_service

logger = structlog.get_logger()

# well-known sites opened without a search (each search costs one of the limited free SerpAPI calls)
KNOWN = {
    "youtube": "https://www.youtube.com", "google": "https://www.google.com", "gmail": "https://mail.google.com",
    "google maps": "https://www.google.com/maps", "maps": "https://www.google.com/maps",
    "wikipedia": "https://www.wikipedia.org", "github": "https://github.com", "linkedin": "https://www.linkedin.com",
    "amazon": "https://www.amazon.in", "flipkart": "https://www.flipkart.com", "instagram": "https://www.instagram.com",
    "facebook": "https://www.facebook.com", "twitter": "https://x.com", "x": "https://x.com",
    "netflix": "https://www.netflix.com", "irctc": "https://www.irctc.co.in", "chatgpt": "https://chatgpt.com",
    "stack overflow": "https://stackoverflow.com", "stackoverflow": "https://stackoverflow.com",
    "zomato": "https://www.zomato.com", "swiggy": "https://www.swiggy.com", "redbus": "https://www.redbus.in",
    "makemytrip": "https://www.makemytrip.com", "spotify": "https://open.spotify.com",
}

_FILLER = r"(?:please |can you |could you |hey aura |aura )*"
OPEN_SITE = re.compile(rf"^{_FILLER}(?:open|go to|visit|take me to|show me)\s+(?:the\s+)?(.+?)"
                       r"(?:\s+(?:web ?site|site|home ?page|page))?\s*[.!?]?$", re.I)
OFFICIAL = re.compile(r"\b(official (?:web ?site|site|page|download(?: page)?|docs|documentation)|download page|"
                      r"documentation|docs)\b", re.I)
SEARCH = re.compile(rf"^{_FILLER}(?:search(?: the web| online| google)?(?: for)?|google|look up|"
                    r"find (?:information|info|details|out) (?:about|on)|tell me (?:the )?latest (?:news )?(?:about|on))\s+(.+?)\s*[.!?]?$",
                    re.I)
NEWS = re.compile(r"\b(latest|news|today'?s|recent|this week|headlines?)\b", re.I)
NEAR_ME = re.compile(r"\b(near me|nearby|around me|close to me|close by)\b", re.I)
CHEAPEST = re.compile(r"\b(cheapest|lowest price|best price|best deal)\b", re.I)
# "check the price of milk on Blinkit", "how much does milk cost online", "price of iPhone 16"
PRICE = re.compile(rf"^{_FILLER}(?:check (?:the )?price of|what(?:'s| is) the price of|price of|"
                   r"how much (?:does|do|is|are) (.+?) cost)\s*(.*?)(?:\s+(?:on|at|from|in)\s+([a-z][a-z ]{1,20}))?"
                   r"(?:\s+online)?\s*[?.!]?$", re.I)
_NOT_A_SITE = re.compile(r"^(it|that|this|that one|this one|there|the (?:first|second|third) one|first one|second one|"
                         r"site|website|link|page)$", re.I)

CACHE_S = 3600
_cache: dict[tuple[str, bool], tuple[float, list["Result"]]] = {}


@dataclass
class Result:
    title: str
    url: str
    snippet: str = ""
    source: str = ""
    date: str = ""

    @property
    def domain(self) -> str:
        return urlparse(self.url).netloc.removeprefix("www.")


@dataclass
class Reply:
    say: str
    url: str | None = None                      # open this now
    results: list[Result] = field(default_factory=list)


async def search(query: str, news: bool = False, num: int = 6) -> list[Result]:
    """Real Google results (organic or news), https only, no direct program/archive downloads. Cached for an hour."""
    key = (query.lower().strip(), news)
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < CACHE_S:
        return hit[1]
    params = {"engine": "google", "q": query, "num": num, "gl": "in", "hl": "en"}
    if news:
        params["tbm"] = "nws"
    data = await travel_service._serpapi_get(params)
    rows = data.get("news_results" if news else "organic_results") or []
    out = []
    for r in rows:
        url = r.get("link") or ""
        if not L.safe(url):
            continue
        src = r.get("source")
        out.append(Result(title=(r.get("title") or "").strip(), url=url, snippet=(r.get("snippet") or "").strip(),
                          source=(src.get("name") if isinstance(src, dict) else src) or urlparse(url).netloc.removeprefix("www."),
                          date=r.get("date") or ""))
    _cache[key] = (time.time(), out[:num])
    return out[:num]


def _subject(text: str) -> str:
    t = re.sub(r"^\W+|\W+$", "", text)
    t = re.sub(r"^(?:find|open|show me|get|search for|search|look up|go to)\s+(?:me\s+)?", "", t, flags=re.I)
    t = re.sub(r"\b(?:the\s+)?(?:official\s+)?(?:web ?site|site|home ?page|download page|documentation|docs|page)\s+(?:for|of)\s+",
               "", t, flags=re.I)
    t = re.sub(r"\b(?:official\s+)?(?:web ?site|site|home ?page|download page|documentation|docs)\b", "", t, flags=re.I)
    t = re.sub(r"\bthe\b|\bpython library\b|\blibrary\b|\bsoftware\b|\bcompany\b", " ", t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip(" ,.")


def _tokens(text: str) -> list[str]:
    return [w for w in re.findall(r"[a-z0-9]+", text.lower()) if len(w) > 2]


def best_official(subject: str, results: list[Result]) -> Result | None:
    """The result whose domain carries the subject's name ("pandas" -> pandas.pydata.org); else None (no guessing)."""
    words = _tokens(subject)
    for r in results:
        dom = r.domain.lower().replace("-", "")
        if words and any(w in dom for w in words):
            return r
    return None


async def _summary(question: str, results: list[Result]) -> str:
    listing = "\n".join(f"[{i + 1}] {r.source}{' (' + r.date + ')' if r.date else ''}: {r.title}. {r.snippet}"
                        for i, r in enumerate(results[:5]))
    try:
        out = await llm_service.chat_json([
            {"role": "system", "content": (
                "Summarise web search results for a voice assistant. Use ONLY the facts in the numbered results; "
                "never add anything else. Two or three short sentences, naming the source of each fact (e.g. "
                "'according to Reuters'). Reply as JSON: {\"summary\": \"...\"}")},
            {"role": "user", "content": f"Question: {question}\n\nResults:\n{listing}"}], max_tokens=500, timeout=20,
            retries=1)
        text = str(out.get("summary") or "").strip()
        if text:
            return text
    except LLMServiceError as exc:
        logger.warning("web_summary_failed", error=str(exc)[:120])
    # no AI: the headlines themselves, with their sources
    return " ".join(f"{r.source}: {r.title}." for r in results[:3])


def _site_name(r: Result) -> str:
    return r.domain


async def handle(message: str, user_id: str) -> Reply | None:
    """A reply for a web search / open-a-website request; None when the message isn't one."""
    text = (message or "").strip()
    if not text:
        return None

    if NEAR_ME.search(text) and not re.search(r"\b(flight|train|bus|cab)\b", text, re.I):
        what = re.sub(rf"^{_FILLER}(?:search for|search|find|show me|look for|open)?\s*", "", text, flags=re.I)
        what = re.sub(r"[.!?]+$", "", what).strip() or text
        url = "https://www.google.com/maps/search/" + quote_plus(what)
        L.remember(user_id, [L.Link(site="Google Maps", url=url, label=what)])
        return Reply(url=url, say=f"Opening Google Maps for {what}; it uses your phone's location to show what's close. "
                                  "I can't see the places myself, so pick one there.")

    official = OFFICIAL.search(text)
    m_open = OPEN_SITE.match(text)
    if m_open and not official:
        name = m_open.group(1).strip().lower()
        if _NOT_A_SITE.match(name) or re.search(r"\b(app|settings|camera|my )\b", name):
            return None
        if name in KNOWN:
            url = KNOWN[name]
            L.remember(user_id, [L.Link(site=urlparse(url).netloc.removeprefix("www."), url=url)])
            return Reply(url=url, say=f"Opening {m_open.group(1).strip()}.")
        if re.fullmatch(r"[a-z0-9-]+(\.[a-z0-9-]+)+", name):
            url = f"https://{name}"
            L.remember(user_id, [L.Link(site=name, url=url)])
            return Reply(url=url, say=f"Opening {name}.")
        official = True     # "open the Zerodha website": find its official site, then open it

    if official:
        subject = _subject(text)
        if not subject:
            return Reply(say="Which company, library or software do you mean?")
        kind = ("download page" if re.search(r"download", text, re.I)
                else "documentation" if re.search(r"\b(docs|documentation)\b", text, re.I) else "website")
        try:
            results = await search(f"{subject} official {kind}")
        except travel_service.TravelServiceError as exc:
            logger.warning("web_search_failed", error=str(exc)[:160])
            return Reply(say="I couldn't reach web search right now, so I can't look that up. Please try again in a bit.")
        best = best_official(subject, results)
        if best is None:
            top = results[:3]
            if not top:
                return Reply(say=f"I couldn't find an official {kind} for {subject}.")
            L.remember(user_id, [L.Link(site=_site_name(r), url=r.url, label=r.title) for r in top], ask=True)
            names = "; ".join(f"{i + 1}, {r.title} on {r.domain}" for i, r in enumerate(top))
            return Reply(results=top, say=f"I couldn't tell which one is the official {kind} for {subject}. The top results "
                                          f"are: {names}. Which one should I open?")
        link = L.Link(site=best.domain, url=best.url, label=best.title)
        wants_open = bool(re.match(rf"^{_FILLER}(open|go to|take me to|visit)\b", text, re.I))
        L.remember(user_id, [link], ask=not wants_open)
        if wants_open:
            return Reply(url=best.url, results=[best], say=f"Opening {best.domain}: {best.title}.")
        return Reply(results=[best], say=f"The official {kind} for {subject} is {best.domain}: {best.title}. "
                                         "Shall I open it?")

    pm = PRICE.match(text)
    if pm:
        product = (pm.group(1) or pm.group(2) or "").strip(" ?.")
        if product:
            return await price_reply(product, (pm.group(3) or "").strip(), user_id)

    m = SEARCH.match(text)
    cheapest = CHEAPEST.search(text) and re.search(r"\b(find|search|look up|what'?s)\b", text, re.I)
    if m or cheapest:
        query = (m.group(1) if m else re.sub(r"^\W*(?:find|search for|search|look up|what'?s)\s+(?:me\s+)?(?:the\s+)?", "",
                                             text, flags=re.I)).strip(" ?.!")
        news = bool(NEWS.search(text))
        try:
            results = await search(query, news=news)
        except travel_service.TravelServiceError as exc:
            logger.warning("web_search_failed", error=str(exc)[:160])
            return Reply(say="I couldn't reach web search right now, so I can't look that up. Please try again in a bit.")
        if not results:
            return Reply(say=f"I didn't find anything for {query}.")
        summary = await _summary(text, results)
        L.remember(user_id, [L.Link(site=r.source or r.domain, url=r.url, label=r.title) for r in results[:5]])
        tail = " Prices change often, so check the site before buying." if cheapest else ""
        return Reply(results=results, say=f"{summary}{tail} Say \"open the first one\" to read it.")
    return None



async def prices(product: str) -> list[dict]:
    """Real current listings with prices (Google Shopping via SerpAPI, India)."""
    data = await travel_service._serpapi_get({"engine": "google_shopping", "q": product, "gl": "in", "hl": "en"})
    out = []
    for r in data.get("shopping_results") or []:
        price = r.get("extracted_price")
        link = r.get("product_link") or r.get("link") or ""
        if not isinstance(price, (int, float)) or not L.safe(link):
            continue
        out.append({"title": (r.get("title") or "").strip(), "price": float(price), "seller": r.get("source") or "",
                    "url": link})
    return out


async def price_reply(product: str, store: str, user_id: str) -> Reply:
    """The cheapest real listings for a product, with seller and link; never an invented price. A store that isn't in
    the listings (quick-commerce apps often aren't) is said plainly."""
    try:
        found = await prices(product)
    except travel_service.TravelServiceError as exc:
        logger.warning("price_search_failed", error=str(exc)[:160])
        return Reply(say="I couldn't reach price search right now, so I can't tell you a price. Please try again in a bit.")
    if not found:
        return Reply(say=f"I didn't find any current listings with a price for {product}.")
    # only the product asked for: every word of it in the title, and the size when one was said (seen: "amul toned
    # milk 500ml" ranked buttermilk and a 1-litre pack as cheapest)
    matching = [f for f in found if _matches(product, f["title"])]
    if not matching:
        return Reply(say=f"I found listings, but none clearly for {product}, so I won't quote a price. Try naming it "
                         "more simply, like the brand and size.")
    found = matching
    note = ""
    if store:
        at = [f for f in found if store.lower().replace(" ", "") in f["seller"].lower().replace(" ", "")]
        if at:
            found = at
        else:
            note = (f"{store.title()} doesn't show up in the online price listings, so I can't see its price from here; "
                    f"say \"order {product} from {store}\" and I'll check it in the app. ")
    best = sorted(found, key=lambda f: f["price"])[:3]
    L.remember(user_id, [L.Link(site=f["seller"] or urlparse(f["url"]).netloc, url=f["url"], label=f["title"]) for f in best])
    rows = "; ".join(f"{f['title'][:60]} for ₹{f['price']:,.0f} at {f['seller']}" for f in best)
    return Reply(results=[], say=f"{note}Cheapest current listings I found: {rows}. Prices change often, so check "
                                 "before buying. Say \"open the first one\" to see it.")


_UNIT = r"(ml|l|ltr|litre|liter|g|gm|kg|pc|pcs)"


def _matches(product: str, title: str) -> bool:
    t = re.sub(r"[^a-z0-9 ]", " ", title.lower())
    t_compact = t.replace(" ", "")
    for size in re.findall(rf"(\d+(?:\.\d+)?)\s*{_UNIT}\b", product.lower()):
        if not re.search(rf"{size[0]}\s*{size[1]}", t):
            return False
    words = [w for w in re.findall(r"[a-z]+", re.sub(rf"\d+(?:\.\d+)?\s*{_UNIT}\b", " ", product.lower()))
             if len(w) >= 3 and w not in {"online", "price", "the", "and", "for", "pack"}]
    # whole words, so "milk" isn't found inside "buttermilk" ... but "butter milk" (two words) still is
    return all(re.search(rf"\b{w}\b", t) for w in words) and not ("butter" not in product.lower() and "butter" in t)
