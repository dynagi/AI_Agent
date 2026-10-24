"""Searching the web and opening websites: answers come from real results (a fake SerpAPI here), sources are named,
official sites are matched by domain (never guessed), and "open it" / "open the second one" / "yes" open exactly
what was offered. Only https pages are opened; program downloads never are."""
import asyncio

import pytest

from app.assistant import links, web
from app.routers import companion
from app.services import travel_service

NEWS = {"news_results": [
    {"title": "OpenAI ships a new model", "link": "https://www.reuters.com/tech/ai-model", "source": {"name": "Reuters"},
     "date": "2 hours ago", "snippet": "The company released..."},
    {"title": "India's AI mission expands", "link": "https://www.thehindu.com/sci-tech/ai", "source": {"name": "The Hindu"},
     "snippet": "The government said..."},
    {"title": "Bad link", "link": "http://insecure.example.com/x", "source": {"name": "Insecure"}}]}
ORGANIC = {
    "pandas official documentation": {"organic_results": [
        {"title": "pandas documentation", "link": "https://pandas.pydata.org/docs/", "snippet": "pandas is..."},
        {"title": "pandas - PyPI", "link": "https://pypi.org/project/pandas/"}]},
    "zerodha official website": {"organic_results": [
        {"title": "Zerodha - India's biggest stock broker", "link": "https://zerodha.com/"}]},
    "vlc official download page": {"organic_results": [
        {"title": "VLC installer", "link": "https://get.videolan.org/vlc/3.0/win64/vlc-3.0-win64.exe"},
        {"title": "Download official VLC media player", "link": "https://www.videolan.org/vlc/"}]},
    "acme official website": {"organic_results": [
        {"title": "Some review site", "link": "https://reviews.example.org/acme"},
        {"title": "Another blog", "link": "https://blog.example.net/x"}]},
}


@pytest.fixture
def fake(monkeypatch):
    calls = []

    async def serpapi(params):
        calls.append(params)
        if params.get("tbm") == "nws":
            return NEWS
        return ORGANIC.get(params["q"].lower(), {"organic_results": []})
    monkeypatch.setattr(travel_service, "_serpapi_get", serpapi)

    async def chat_json(messages, **kw):
        listing = messages[-1]["content"]
        assert "Reuters" in listing          # the summary is built only from the results it is given
        return {"summary": "According to Reuters, OpenAI shipped a new model; The Hindu reports India's AI mission is expanding."}
    monkeypatch.setattr(web.llm_service, "chat_json", chat_json)
    web._cache.clear()
    links.forget("u1")
    companion._recent.clear()
    return calls


def ask(message):
    return asyncio.run(companion.converse(companion.ConverseRequest(message=message, userId="u1")))


def test_news_search_is_summarised_from_real_results_with_sources(fake):
    r = ask("search for the latest AI news")
    assert "According to Reuters" in r.say and "open the first one" in r.say and not r.do
    assert fake[0]["tbm"] == "nws" and fake[0]["q"] == "the latest AI news"
    second = ask("open the second one")
    assert second.do[0].args["url"] == "https://www.thehindu.com/sci-tech/ai" and "The Hindu" in second.say
    assert all("insecure" not in link.url for link in links.latest("u1"))       # plain http never offered


def test_official_site_is_matched_by_domain_then_opened_on_yes(fake):
    r = ask("find the official website for Zerodha")
    assert "zerodha.com" in r.say and r.say.endswith("Shall I open it?") and not r.do
    yes = ask("yes")
    assert yes.do[0].type == "open_url" and yes.do[0].args["url"] == "https://zerodha.com/"


def test_open_documentation_opens_right_away(fake):
    r = ask("open the documentation for pandas python library")
    assert r.do[0].args["url"] == "https://pandas.pydata.org/docs/" and r.say.startswith("Opening pandas.pydata.org")


def test_download_page_never_opens_an_installer(fake):
    r = ask("find the official download page for VLC")
    assert "videolan.org" in r.say and ".exe" not in r.say
    assert ask("open it").do[0].args["url"] == "https://www.videolan.org/vlc/"


def test_no_official_match_lists_results_instead_of_guessing(fake):
    r = ask("find the official website for Acme")
    assert "couldn't tell which one is the official" in r.say and r.say.endswith("Which one should I open?")
    assert ask("open the first one").do[0].args["url"] == "https://reviews.example.org/acme"


def test_known_sites_and_near_me_open_without_spending_a_search(fake):
    assert ask("open wikipedia").do[0].args["url"] == "https://www.wikipedia.org"
    r = ask("restaurants near me")
    assert r.do[0].args["url"].startswith("https://www.google.com/maps/search/restaurants") and "location" in r.say
    assert ask("open the website you recommended earlier").do[0].args["url"].startswith("https://www.google.com/maps")
    assert fake == []


def test_search_down_is_said_plainly(fake, monkeypatch):
    async def down(params):
        raise travel_service.TravelServiceError("SerpAPI request failed (429)")
    monkeypatch.setattr(travel_service, "_serpapi_get", down)
    r = ask("search for best laptops under 50000")
    assert "couldn't reach web search" in r.say and not r.do


def test_nothing_offered_means_open_it_is_not_hijacked(fake):
    r = ask("open it")
    assert not (r.do and r.do[0].type == "open_url")


def test_unsafe_links_are_refused():
    assert links.safe("https://www.videolan.org/vlc/")
    assert not links.safe("http://example.com") and not links.safe("https://x.com/setup.exe")
    assert not links.safe("intent://evil") and not links.safe("javascript:alert(1)")
