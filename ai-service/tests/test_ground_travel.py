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
