"""The flight assistant: reading Google Flights data, ranking by the user's preferences rather than price alone,
per-website prices, the conversation, and learning. Search and the language model are replaced by fakes."""
import asyncio

import pytest

from app.travel import assistant as fa
from app.travel import flights as live
from app.travel import preferences as fp


def leg(airline, number, frm, to, dep, arr, minutes, legroom=None, notes=()):
    return {"airline": airline, "flight_number": number, "departure_airport": {"id": frm, "name": frm, "time": dep},
            "arrival_airport": {"id": to, "name": to, "time": arr}, "duration": minutes, "airplane": "A320",
            "legroom": legroom, "extensions": list(notes)}


# shaped like a real Google Flights response (BLR -> IXC)
SEARCH = {
    "best_flights": [
        {"price": 14609, "total_duration": 320, "booking_token": "tok-cheap", "type": "One way",
         "flights": [leg("IndiGo", "6E 6753", "BLR", "GOI", "2026-10-31 16:10", "2026-10-31 17:30", 80,
                         notes=["Below average legroom (28 in)", "Carbon emissions estimate: 47 kg"]),
                     leg("IndiGo", "6E 724", "GOI", "IXC", "2026-10-31 18:50", "2026-10-31 21:30", 160)],
         "layovers": [{"id": "GOI", "name": "Goa", "duration": 80}]},
        {"price": 16200, "total_duration": 190, "booking_token": "tok-direct-morning",
         "flights": [leg("Air India", "AI 811", "BLR", "IXC", "2026-10-31 09:05", "2026-10-31 12:15", 190)],
         "layovers": []},
    ],
    "other_flights": [
        {"price": 15100, "total_duration": 200, "booking_token": "tok-direct-night",
         "flights": [leg("IndiGo", "6E 2201", "BLR", "IXC", "2026-10-31 23:40", "2026-11-01 03:00", 200)],
         "layovers": []},
        {"price": 13900, "total_duration": 720, "booking_token": "tok-long",
         "flights": [leg("SpiceJet", "SG 1", "BLR", "DEL", "2026-10-31 05:00", "2026-10-31 07:50", 170),
                     leg("SpiceJet", "SG 2", "DEL", "IXC", "2026-10-31 15:50", "2026-10-31 17:00", 70)],
         "layovers": [{"id": "DEL", "name": "Delhi", "duration": 480}]},
    ],
    "price_insights": {"lowest_price": 13900, "price_level": "high", "typical_price_range": [8000, 11000]},
    "search_metadata": {"google_flights_url": "https://www.google.com/travel/flights?..."},
}
SITES = {
    "tok-direct-morning": {"booking_options": [
        {"book_with": "Air India", "price": 16200, "baggage_prices": ["1 free carry-on", "1st checked bag free"]},
        {"book_with": "EaseMyTrip", "price": 15890, "baggage_prices": ["1 free carry-on", "1st checked bag free"]},
        {"together": {"book_with": "Cleartrip", "price": 16010, "baggage_prices": []}}]},
    "tok-cheap": {"booking_options": [{"book_with": "skyticket", "price": 13700, "baggage_prices": ["1 free carry-on"]}]},
    "tok-long": {"booking_options": [{"book_with": "SpiceJet", "price": 13900, "baggage_prices": []}]},
    "tok-direct-night": {"booking_options": [{"book_with": "IndiGo", "price": 15100, "baggage_prices": []}]},
}


@pytest.fixture
def fake(monkeypatch):
    calls = {"search": 0, "sites": 0, "events": []}

    async def serpapi(params):
        if "booking_token" in params:
            calls["sites"] += 1
            return SITES[params["booking_token"]]
        calls["search"] += 1
        return SEARCH
    monkeypatch.setattr(live.travel_service, "_serpapi_get", serpapi)

    replies = []

    async def chat_json(messages, **kw):
        return replies.pop(0) if replies else {"relevant": True}
    monkeypatch.setattr(fa.llm_service, "chat_json", chat_json)

    async def add_event(uid, e):
        calls["events"].append(e)
        return "memory"

    async def get_events(uid):
        return list(calls["events"])
    monkeypatch.setattr(fa.travel_history, "add_event", add_event)
    monkeypatch.setattr(fa.travel_history, "get_events", get_events)
    fa.reset("u1")
    calls["replies"] = replies
    yield calls
    fa.reset("u1")


TRIP = {"relevant": True, "origin_city": "Bangalore", "origin_code": "BLR", "destination_city": "Chandigarh",
        "destination_code": "IXC", "date": "2099-10-31"}


def say(text):
    return asyncio.run(fa.handle(text, "u1"))


def test_reads_every_detail_google_flights_gives():
    fl = live.parse_flights(SEARCH)
    cheap = fl[0]
    assert (cheap.airline, cheap.stops, cheap.minutes, cheap.price) == ("IndiGo", 1, 320, 14609)
    assert cheap.layovers[0].code == "GOI" and cheap.layovers[0].minutes == 80
    assert cheap.flight_numbers == "6E 6753, 6E 724" and cheap.depart_hour == 16
    assert cheap.notes == ["Below average legroom (28 in)"]                      # carbon estimate left out
    sites = live.parse_sites(SITES["tok-direct-morning"], ["Air India"])
    assert [s.site for s in sites] == ["EaseMyTrip", "Cleartrip", "Air India"]   # cheapest site first
    assert sites[-1].is_airline and sites[0].baggage == ["1 free carry-on", "1st checked bag free"]


def test_best_fit_is_not_simply_the_cheapest():
    fl = live.parse_flights(SEARCH)
    by_time = fp.score(fl, fp.FlightPrefs(priority="time"))
    assert by_time[0].flight.airline == "Air India"                              # direct, 3 h 10 min
    by_price = fp.score(fl, fp.FlightPrefs(priority="price"))
    assert by_price[0].flight.price == 13900                                     # "price matters most": the cheapest
    balanced = fp.score(fl, fp.FlightPrefs())
    assert balanced[0].flight.price != 13900                                     # by default a 12-hour trip doesn't win
    morning = fp.score(fl, fp.FlightPrefs(time_of_day="morning", direct=True))
    assert morning[0].flight.legs[0].flight_number == "AI 811"
    night = fp.score(*fp.eligible(fl, fp.FlightPrefs(time_of_day="night", direct=True))[:1], fp.FlightPrefs(time_of_day="night", direct=True))
    assert night[0].flight.legs[0].flight_number == "6E 2201"


def test_hard_requirements_and_honest_relaxing():
    fl = live.parse_flights(SEARCH)
    pool, notes = fp.eligible(fl, fp.FlightPrefs(direct=True, budget=15500))
    assert [f.legs[0].flight_number for f in pool] == ["6E 2201"] and notes == []
    pool, notes = fp.eligible(fl, fp.FlightPrefs(budget=5000))
    assert len(pool) == 4 and "Nothing is within ₹5,000" in notes[0]           # nothing fits: said, not hidden
    gains = fp.why_better(fl[1], fl[3], fp.FlightPrefs(time_of_day="morning"))
    assert "direct" in gains and "shorter" in gains and "no long wait" in gains


def test_full_conversation_asks_then_recommends_and_compares_sites(fake):
    fake["replies"] += [dict(TRIP), {"relevant": True, "direct": True, "time_of_day": "morning", "priority": "time"}]
    q = say("find me a flight from Bangalore to Chandigarh on 31st October")
    assert "direct flight" in q and "what matters most" in q and fake["search"] == 0   # asks before searching
    r = say("direct, morning, shortest travel time")
    assert fake["search"] == 1
    assert "Air India AI 811" in r and "9:05 am" in r and "direct" in r
    assert "₹15,890 on EaseMyTrip" in r and "airline's own site is ₹16,200" in r      # cheapest site for that flight
    assert "the cheapest overall is SpiceJet SG 1" in r                                  # says what the extra buys
    assert "Prices are high for this date" in r
    assert fake["sites"] <= 2                                                            # searches kept to a minimum


def test_asks_only_for_what_is_missing(fake):
    fake["replies"] += [{"relevant": True, "destination_city": "Delhi", "destination_code": "DEL"}]
    q = say("I want to fly to Delhi")
    assert "where you're flying from" in q and "which date" in q and "where to" not in q


def test_choice_is_learned_and_offered_next_time(fake):
    fake["replies"] += [dict(TRIP, direct=True, time_of_day="morning", priority="time"), {"relevant": True, "choose": 1}]
    say("flight from Bangalore to Chandigarh on the 31st, direct, morning, fastest")
    done = say("the first one")
    assert "Noted: Air India AI 811" in done and "EaseMyTrip" in done and "can't book or pay" in done
    assert any(e["action"] == fp.CHOICE_EVENT for e in fake["events"])
    assert any(e["action"] == fp.PREF_EVENT and e.get("direct") is True for e in fake["events"])
    # next trip: instead of the long question, AURA offers what it learned
    fake["replies"] += [dict(TRIP)]
    q = say("book me a flight from Bangalore to Chandigarh on the 31st")
    assert q.startswith("Last time you liked") and "direct" in q and "morning" in q


def test_feedback_reranks_without_a_new_search(fake):
    fake["replies"] += [dict(TRIP, priority="price"), {"relevant": True, "time_of_day": "night", "direct": True}]
    first = say("cheapest flight Bangalore to Chandigarh on the 31st")
    assert fake["search"] == 1 and "For you I'd pick" in first
    again = say("actually I prefer a direct night flight")
    assert fake["search"] == 1 and "6E 2201" in again


def test_other_topics_are_left_to_the_general_chat(fake):
    assert say("what's the capital of Japan") is None
    fake["replies"] += [dict(TRIP, priority="price"), {"relevant": False}]
    say("flight from Bangalore to Chandigarh on the 31st, cheapest")
    assert say("remind me to drink water") is None                                   # moved on: session dropped
    assert fa._session("u1") is None


def test_rule_reading_when_the_ai_is_unavailable():
    r = fa._rules("direct morning flight under 15k please, cheapest")
    assert r["direct"] is True and r["time_of_day"] == "morning" and r["budget"] == 15000 and r["priority"] == "price"
    assert fa._rules("the second one")["choose"] == 2 and fa._rules("yes")["confirm"] is True


def test_learning_needs_repetition_before_assuming():
    once = fp.learned([{"action": fp.CHOICE_EVENT, "time_of_day": "night", "stops": 0, "airline": "IndiGo"}])
    assert once.known() == {}                                                         # one choice: still ask
    twice = fp.learned([{"action": fp.CHOICE_EVENT, "time_of_day": "night", "stops": 0, "airline": "IndiGo"}] * 2)
    assert twice.time_of_day == "night" and twice.direct is True and twice.airline == "IndiGo"
    said = fp.learned([{"action": fp.PREF_EVENT, "priority": "time"}])
    assert said.priority == "time"                                                    # something they said counts more


def test_details_are_given_even_if_the_model_repeats_old_preferences(fake):
    prefs = {"direct": True, "time_of_day": "morning", "priority": "time"}
    fake["replies"] += [dict(TRIP, **prefs), dict({"relevant": True, "wants_details": True}, **prefs)]
    say("flight Bangalore to Chandigarh on the 31st, direct, morning, fastest")
    d = say("show me the details")
    assert d.startswith("Option 1:") and "AI 811" in d and "1st checked bag free" in d   # the one direct morning flight


def test_cheapest_of_the_fitting_flights_is_not_called_the_cheapest(fake):
    fake["replies"] += [dict(TRIP, direct=True, time_of_day="morning", priority="price")]
    r = say("cheapest direct morning flight Bangalore to Chandigarh on the 31st")
    assert "cheapest of the flights that fit" in r and "SpiceJet SG 1 at ₹13,900" in r


def test_every_question_ends_with_a_question_mark_so_aura_keeps_listening(fake):
    fake["replies"] += [{"relevant": True, "destination_city": "Delhi", "destination_code": "DEL"}, dict(TRIP)]
    assert say("I want to fly to Delhi").endswith("?")
    fa.reset("u1")
    assert say("flight from Bangalore to Chandigarh on the 31st").endswith("?")
    assert fa.PREFS_QUESTION.endswith("?")


def test_short_answer_to_the_preference_question_stays_in_the_flight_conversation(fake):
    """Seen on the phone: "direct, morning, cheapest" after AURA's question went to the general chat, because the
    model called it unrelated."""
    fake["replies"] += [dict(TRIP), {"relevant": False}]
    q = say("find me a flight from Bangalore to Chandigarh on the 31st")
    assert "direct flight" in q
    r = say("direct, morning, cheapest")
    assert r is not None and fake["search"] == 1 and "AI 811" in r


def test_pick_cheaper_on_a_website_than_another_flight_is_not_called_more_expensive(fake, monkeypatch):
    """Seen on the phone: ₹9,800 on ly.com for the pick, then "the cheapest overall is ₹9,976"."""
    fake["replies"] += [dict(TRIP, direct=True, time_of_day="morning", priority="price")]
    monkeypatch.setitem(SITES, "tok-direct-morning", {"booking_options": [{"book_with": "ly.com", "price": 13000}]})
    r = say("cheapest direct morning flight Bangalore to Chandigarh on the 31st")
    assert "₹13,000 on ly.com" in r and "It's also the cheapest flight." in r and "cheapest overall" not in r


def test_the_same_sentence_sent_twice_is_answered_once(fake):
    """Seen on the phone: the reply to AURA's question reached the server three times; the repeats were acted on."""
    from app.routers import companion
    companion._recent.clear()
    fake["replies"] += [dict(TRIP), {"relevant": True, "direct": True, "time_of_day": "morning", "priority": "time"},
                        {"relevant": True, "confirm": True}]
    ask = lambda m: asyncio.run(companion.converse(companion.ConverseRequest(message=m, userId="u1"))).say
    ask("find me a flight from Bangalore to Chandigarh on the 31st")
    first = ask("direct, morning, shortest travel time")
    assert ask("direct, morning, shortest travel time") == first and fake["search"] == 1
    assert fa._session("u1") is not None and not any(e["action"] == fp.CHOICE_EVENT for e in fake["events"])


def test_a_copy_arriving_while_the_first_is_still_answered_waits_for_it(fake):
    from app.routers import companion
    companion._recent.clear()
    fake["replies"] += [dict(TRIP), {"relevant": True, "direct": True, "time_of_day": "morning", "priority": "time"},
                        {"relevant": True, "confirm": True}]
    req = lambda m: companion.ConverseRequest(message=m, userId="u1")
    asyncio.run(companion.converse(req("find me a flight from Bangalore to Chandigarh on the 31st")))

    async def both():
        return await asyncio.gather(companion.converse(req("direct, morning, shortest travel time")),
                                    companion.converse(req("Direct, morning, shortest travel time.")))
    a, b = asyncio.run(both())
    assert a.say == b.say and fake["search"] == 1 and fa._session("u1") is not None


def test_open_it_opens_the_recommended_flights_booking_site(fake):
    from app.routers import companion
    companion._recent.clear()
    fake["replies"] += [dict(TRIP, direct=True, time_of_day="morning", priority="time")]
    ask = lambda m: asyncio.run(companion.converse(companion.ConverseRequest(message=m, userId="u1")))
    ask("flight Bangalore to Chandigarh on the 31st, direct, morning, fastest")
    r = ask("open it")
    assert r.say.startswith("Opening EaseMyTrip for Air India AI 811") and r.do[0].type == "open_url"
    assert r.do[0].args["url"] == "https://www.easemytrip.com/flights.html"


def test_a_new_flight_request_starts_fresh_even_for_the_same_trip(fake):
    """Seen on the phone: asking again for the same route got "Okay. Tell me if you want to look again." from the
    previous conversation."""
    fake["replies"] += [dict(TRIP, direct=True, time_of_day="morning", priority="time"), dict(TRIP, confirm=False)]
    say("flight from Bangalore to Chandigarh on the 31st, direct, morning, fastest")
    r = say("find me a flight from Bangalore to Chandigarh on the 31st")
    assert "Okay. Tell me" not in r and ("direct flight" in r or "Last time" in r or "For you" in r)
