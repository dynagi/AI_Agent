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


def test_what_can_you_do_lists_the_real_abilities(fake):
    r = ask("what can you do?")
    assert "Zomato" in r.say and "flights" in r.say and "websites" in r.say and r.say.endswith("?")
    assert not companion._ABILITIES_Q.search("what can you do about my sleep")   # a real question: the chat answers it


def test_natural_ways_to_say_open_it(fake):
    """Seen while recording: "please open the website for me for this flight" and "open it please" did nothing."""
    links.remember("u1", [links.Link(site="Air India", url="https://www.airindia.com", label="Air India AI 811")])
    for said in ("please open the website for me for this flight", "open it please", "book it now",
                 "can you open the booking site"):
        opened = links.open_request(said, "u1")
        assert opened and opened[1] == "https://www.airindia.com", said
    assert links.open_request("find me a flight from Delhi to Goa", "u1") is None
    assert links.open_request("open youtube and play songs", "u1") is None


def test_a_question_never_gets_a_logging_action(monkeypatch):
    """Reported: "How many glasses of water have I drunk today?" added a glass."""
    async def chat_json(*a, **k):
        return {"say": "You've had 3 glasses.", "do": [{"type": "log_water", "args": {"glasses": 1}}]}
    monkeypatch.setattr(companion.llm_service, "chat_json", chat_json)
    companion._recent.clear()
    for q in ("How many glasses of water have I drunk today?", "maine aaj kitne glass paani piye",
              "Did I take my medicine today"):
        r = asyncio.run(companion.converse(companion.ConverseRequest(message=q, userId="u7")))
        assert not any(a.type == "log_water" for a in r.do), q
    companion._recent.clear()
    r = asyncio.run(companion.converse(companion.ConverseRequest(message="I just drank a glass of water", userId="u7")))
    assert any(a.type == "log_water" for a in r.do)


def test_price_check_returns_real_listings_and_says_when_a_store_is_missing(monkeypatch):
    async def serp(params):
        assert params["engine"] == "google_shopping"
        return {"shopping_results": [
            {"title": "Amul Taaza Toned Milk 500 ml", "extracted_price": 29, "source": "BigBasket", "product_link": "https://www.bigbasket.com/x"},
            {"title": "Amul Gold Milk 1 L", "extracted_price": 68, "source": "Amazon.in", "product_link": "https://www.amazon.in/y"},
            {"title": "No price", "source": "X", "product_link": "https://x.com"}]}
    monkeypatch.setattr(travel_service, "_serpapi_get", serp)
    links.forget("u1")
    companion._recent.clear()
    r = ask("check the price of milk on Blinkit")
    assert "Blinkit doesn't show up" in r.say and "₹29 at BigBasket" in r.say and not r.do
    assert ask("open the first one").do[0].args["url"] == "https://www.bigbasket.com/x"
    companion._recent.clear()
    assert "₹68 at Amazon.in" in ask("check the price of milk on amazon").say
