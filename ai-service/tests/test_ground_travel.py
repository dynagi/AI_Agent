"""Trains, buses and shared cabs: no fares are invented; the right page opens with the route. Flights: "open it"
opens the booking site of the flight AURA recommended."""
import asyncio

from app.routers import companion
from app.travel import ground


def test_bus_opens_redbus_for_the_route_without_inventing_fares():
    r = ground.handle("find me a bus from Bangalore to Chennai tomorrow")
    assert r.site == "redBus" and r.url.startswith("https://www.redbus.in/bus-tickets/bangalore-to-chennai?onward=")
    assert "won't guess" in r.say and "Bangalore to Chennai tomorrow" in r.say and "₹" not in r.say


def test_train_and_shared_cab_and_missing_route():
    t = ground.handle("any trains from Pune to Mumbai on Friday?")
    assert t.url.startswith("https://www.ixigo.com/search/result/train/PUNE/CSMT/") and "ixigo" in t.say
    c = ground.handle("is there a shared cab from Delhi to Dehradun")
    assert "shared+cab+from+Delhi+to+Dehradun" in c.url and "some routes" in c.say
    assert ground.handle("book a bus for me").endswith("?")
    assert ground.handle("play some music") is None


def test_chat_route_returns_an_open_url_action():
    companion._recent.clear()
    r = asyncio.run(companion.converse(companion.ConverseRequest(message="bus from Hyderabad to Vijayawada", userId="u9")))
    assert r.do and r.do[0].type == "open_url" and "hyderabad-to-vijayawada?onward=" in r.do[0].args["url"]


def test_chat_cannot_claim_to_open_something_it_isnt_opening():
    """Seen on the phone: the general chat said "Opening the flights from Delhi to Goa..." with nothing opened."""
    say = "I can't see live flight prices. Opening the flights from Delhi to Goa on 27th October, sorted by price."
    assert companion.honest(say, []).startswith("I haven't opened anything")
    url = companion.ConverseAction(type="open_url", args={"url": "https://www.redbus.in"})
    assert companion.honest("Opening redBus for you.", [url]) == "Opening redBus for you."


def test_opening_with_an_order_action_is_not_called_a_false_claim():
    """Seen while recording the demo: "Opening Zomato for paneer biryani" with an order action was replaced."""
    order = companion.ConverseAction(type="order", args={"text": "order paneer biryani from zomato"})
    assert companion.honest("Opening Zomato to order paneer biryani.", [order]).startswith("Opening Zomato")


def test_bus_and_train_open_on_the_date_asked_for():
    """Seen while recording: redBus opened on today for "tomorrow"; trains opened a Google search."""
    from datetime import date
    today = date(2026, 10, 25)
    assert ground.travel_date("bus tomorrow", today) == date(2026, 10, 26)
    assert ground.travel_date("on 30th October", today) == date(2026, 10, 30)
    assert ground.travel_date("on Friday", today) == date(2026, 10, 30)
    assert ground.travel_date("no date", today) == today
    assert "/30102026/" in ground.handle("trains from Pune to Mumbai on 30th October").url
    unknown = ground.handle("trains from Pune to Smalltown")
    assert "google.com/search" in unknown.url and "don't know the station" in unknown.say


def test_plain_cab_between_cities_and_route_without_from():
    """Seen while recording: "find Delhi to Ajmer cab for me" got no answer."""
    r = ground.handle("find delhi to ajmer cab for me")
    assert "outstation+cab+from+Delhi+to+Ajmer" in r.url and "Delhi to Ajmer" in r.say
    assert ground.handle("book a cab to the airport") is None          # a local ride: not this helper
    assert ground.handle("I want to go to work") is None
    assert "/NDLS/AII/" in ground.handle("trains delhi to ajmer tomorrow").url


def test_cab_opens_a_real_cab_site_with_its_listed_fare(monkeypatch):
    """Asked while recording: open a particular site and say the basic fare (from the site's own listing)."""
    from app.assistant import web
    from app.services import travel_service

    async def fake(params):
        return {"organic_results": [
            {"title": "Delhi to Ajmer taxi - Wikipedia style blog", "link": "https://blog.example.com/x"},
            {"title": "Delhi to Ajmer Cab | One Way Taxi from ₹3,499", "link": "https://www.gozocabs.com/book-taxi/delhi-ajmer",
             "snippet": "Book Delhi to Ajmer one way cab..."},
            {"title": "Delhi Ajmer cabs", "link": "https://www.makemytrip.com/cabs/x", "snippet": "Rs 11/km"}]}
    monkeypatch.setattr(travel_service, "_serpapi_get", fake)
    web._cache.clear()
    r = asyncio.run(ground.cab_options(ground.handle("find delhi to ajmer cab for me")))
    assert r.url == "https://www.gozocabs.com/book-taxi/delhi-ajmer" and r.site == "Gozo Cabs"
    assert "₹3,499" in r.say and "search listing" in r.say

    async def down(params):
        raise travel_service.TravelServiceError("429")
    monkeypatch.setattr(travel_service, "_serpapi_get", down)
    web._cache.clear()
    r = asyncio.run(ground.cab_options(ground.handle("find delhi to ajmer cab for me")))
    assert "google.com/search" in r.url                               # search down: the plain search, no made-up fare
