"""Trains, buses and shared cabs: no fares are invented; the right page opens with the route. Flights: "open it"
opens the booking site of the flight AURA recommended."""
import asyncio

from app.routers import companion
from app.travel import ground


def test_bus_opens_redbus_for_the_route_without_inventing_fares():
    r = ground.handle("find me a bus from Bangalore to Chennai tomorrow")
    assert r.site == "redBus" and r.url == "https://www.redbus.in/bus-tickets/bangalore-to-chennai"
    assert "won't guess" in r.say and "Bangalore to Chennai tomorrow" in r.say and "₹" not in r.say


def test_train_and_shared_cab_and_missing_route():
    t = ground.handle("any trains from Pune to Mumbai on Friday?")
    assert "trains+from+Pune+to+Mumbai" in t.url and "IRCTC" in t.say
    c = ground.handle("is there a shared cab from Delhi to Dehradun")
    assert "shared+cab+from+Delhi+to+Dehradun" in c.url and "some routes" in c.say
    assert ground.handle("book a bus for me").endswith("?")
    assert ground.handle("play some music") is None


def test_chat_route_returns_an_open_url_action():
    companion._recent.clear()
    r = asyncio.run(companion.converse(companion.ConverseRequest(message="bus from Hyderabad to Vijayawada", userId="u9")))
    assert r.do and r.do[0].type == "open_url" and "hyderabad-to-vijayawada" in r.do[0].args["url"]
