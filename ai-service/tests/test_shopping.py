"""Shopping model, agent, retraining and cart-agent tests. Offline: the LLM is mocked, demo history is real."""
from __future__ import annotations

import asyncio

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.agents import shopping_agent as sa
from app.agents.coordinator import select_agents
from app.main import app
from app.ml.shopping_catalog import canonical_app, canonical_item
from app.ml.shopping_features import build_frame, normalize_events
from app.ml import shopping_predictor as sp
from app.ml.shopping_predictor import get_predictor, retrain_scheduler
from app.services import shopping_browser as sb
from app.services.llm_service import LLMServiceError
from app.services.shopping_history import shopping_history
from app.shopping.session import sessions

def _days_ago(n: int) -> str:
    """A timestamp n days before now: for "history was read recently", which must stay recent on any test day."""
    return (pd.Timestamp.now() - pd.Timedelta(days=n)).isoformat()


DEMO = "USER_000001"  # bachelor, buys mostly on Swiggy Instamart
AS_OF = "2026-10-01T09:00:00"
client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    shopping_history.clear_memory(DEMO)
    sessions.clear(DEMO)
    sessions.clear("11111111-2222-3333-4444-555555555555")
    retrain_scheduler.reasons = []
    # commands schedule a retrain; tests run it explicitly instead of waiting on a timer
    monkeypatch.setattr(retrain_scheduler, "request", lambda reason: {"scheduled": True, "reason": reason})
    yield
    shopping_history.clear_memory(DEMO)


def _llm(monkeypatch, answer):
    async def fake(messages, **kw):
        if isinstance(answer, Exception):
            raise answer
        return answer
    monkeypatch.setattr(sa.llm_service, "chat_json", fake)


# ---------------------------------------------------------------- catalog + features
def test_free_text_maps_to_catalog_items_and_stores():
    assert canonical_item("Amul Taaza toned milk 1L") == "milk"
    assert canonical_item("2 packets of Maggi") == "instant noodles"
    assert canonical_item("Surf Excel Easy Wash 1kg") == "detergent"
    assert canonical_item("Organic quinoa 500g") == "organic quinoa"  # unknown items keep their own name
    assert canonical_app("swiggy") == "Swiggy" and canonical_app("swiggy instamart") == "Swiggy Instamart"
    assert canonical_app("Amazon") == "Amazon"


def test_features_only_use_the_past():
    events = [
        {"timestamp": "2026-09-01T09:00", "action": "order", "name": "milk", "app": "Zepto"},
        {"timestamp": "2026-09-03T09:00", "action": "order", "name": "milk", "app": "Zepto"},
        {"timestamp": "2026-09-05T09:00", "action": "order", "name": "milk", "app": "Zepto"},
        {"timestamp": "2026-09-20T09:00", "action": "order", "name": "milk", "app": "Blinkit"},  # future
    ]
    df, _ = build_frame(events, pd.Timestamp("2026-09-06T00:00"), get_predictor().stats)
    milk = df[df["item"] == "milk"].iloc[0]
    assert milk["n_orders"] == 3
    assert milk["mean_gap"] == pytest.approx(2.0)
    assert milk["days_since_last_order"] == pytest.approx(0.625)


def test_normalize_handles_mixed_inputs():
    ev = normalize_events([
        {"timestamp": "2026-09-01T09:00:00+00:00", "action": "ORDER", "name": "Dettol soap", "app": "bigbasket"},
        {"timestamp": "2026-09-01T10:00:00", "action": "order", "item": "eggs", "qty": "2"},
        {"timestamp": None, "action": "order", "name": "bread"},          # no time -> dropped
        {"timestamp": "2026-09-02", "action": "teleport", "name": "x"},   # unknown action -> dropped
    ])
    assert list(ev["item"]) == ["eggs", "soap"]  # 09:00 UTC is 14:30 IST, after 10:00 IST
    assert ev.loc[ev["item"] == "soap", "app"].item() == "BigBasket"
    assert ev.loc[ev["item"] == "eggs", "qty"].item() == 2


# ---------------------------------------------------------------- predictions
def test_demo_user_forecast():
    r = client.get("/ai/shopping/predict", params={"userId": DEMO, "asOf": AS_OF}).json()
    assert r["status"] == "ok"
    items = r["nextPurchases"]
    assert items and items == sorted(items, key=lambda i: -i["probability"])
    assert {"milk", "bread"} <= {i["item"] for i in items}
    assert items[0]["store"] == "Swiggy Instamart"
    assert r["suggestedBaskets"][0]["store"] == "Swiggy Instamart"
    assert r["history"]["favouriteStores"][0]["store"] == "Swiggy Instamart"


def test_unknown_user_is_cold_start():
    r = client.get("/ai/shopping/predict", params={"userId": "nobody"}).json()
    assert r["status"] == "cold_start" and r["nextPurchases"] == []


def test_logged_events_change_the_forecast_immediately():
    before = client.get("/ai/shopping/predict", params={"userId": DEMO, "asOf": AS_OF}).json()
    assert "protein powder" not in {i["item"] for i in before["nextPurchases"] + before["alsoPossible"]}
    client.post("/ai/shopping/events", json={"userId": DEMO, "events": [
        {"action": "order", "name": "whey protein 1kg", "app": "Amazon", "timestamp": f"2026-0{m}-0{d}T10:00:00"}
        for m, d in [(7, 1), (7, 9), (8, 1), (8, 9), (9, 1), (9, 9)]
    ] + [{"action": "search", "name": "whey protein", "timestamp": "2026-09-30T20:00:00"}]})
    after = client.get("/ai/shopping/predict", params={"userId": DEMO, "asOf": AS_OF}).json()
    protein = next(i for i in after["nextPurchases"] + after["alsoPossible"] if i["item"] == "protein powder")
    assert protein["store"] == "Amazon"
    assert protein["timesOrdered"] == 6


# ---------------------------------------------------------------- agent
def test_order_command_builds_a_cart_job_and_logs_it(monkeypatch):
    _llm(monkeypatch, {"intent": "order", "store": "zepto", "reorder_usual": False,
                       "items": [{"name": "Amul milk 1L", "qty": 2}, {"name": "eggs", "qty": 1}]})
    r = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "order 2 amul milk and eggs from zepto",
                                               "asOf": AS_OF}).json()
    assert "cartOrder" not in r["data"] and r["data"]["assist"]["pending"]      # eggs are new for this user: ask
    assert "haven't bought" in r["data"]["assist"]["say"]
    r = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "yes", "asOf": AS_OF}).json()
    job = r["data"]["cartOrder"]
    assert job["store"] == "Zepto" and job["startUrl"].startswith("https://www.zeptonow.com")
    assert job["items"] == [{"name": "Amul milk 1L", "qty": 2}, {"name": "eggs", "qty": 1}]
    assert r["data"]["retrain"]["scheduled"]
    logged = asyncio.run(shopping_history.get_events(DEMO))[-2:]
    assert [canonical_item(e["name"]) for e in logged] == ["milk", "eggs"]
    # a command is intent, not a purchase: what lands in the cart is logged as an order when the job ends
    assert all(e["action"] == "add_to_cart" and e["source"] == "agent_command" and e["app"] == "Zepto" for e in logged)
    assert job["syncHistory"] is True and job["resolved"] is False  # Zepto history never read: read it first


def test_usual_order_without_store_uses_model(monkeypatch):
    _llm(monkeypatch, LLMServiceError("down"))  # also exercises the offline fallback parser
    r = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "get my usual groceries", "asOf": AS_OF}).json()
    a = r["data"]["assist"]
    assert a["pending"] and a["question"] == "confirm" and "Swiggy Instamart" in a["say"]  # one yes, not a quiz
    r = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "haan kar do", "asOf": AS_OF}).json()
    job = r["data"]["cartOrder"]
    assert job["store"] == "Swiggy Instamart"  # where this user buys these
    assert {"milk", "bread"} <= {i["name"] for i in job["items"]}


def test_any_store_is_accepted(monkeypatch):
    _llm(monkeypatch, {"intent": "order", "store": "Lulu Hypermarket", "items": [{"name": "rice 5kg", "qty": 1}]})
    first = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "order rice from lulu"}).json()["data"]
    assert "cartOrder" not in first and first["assist"]["question"] == "confirm"
    job = client.post("/ai/shopping/ask", json={"userId": DEMO, "message": "yes"}).json()["data"]["cartOrder"]
    assert job["store"] == "Lulu Hypermarket" and job["storeKey"] is None
    assert job["startUrl"].startswith("https://www.google.com/search?q=Lulu+Hypermarket")


@pytest.mark.parametrize("text,intent,store,items", [
    ("order milk x2, bread and 3 eggs from Zepto", "order", "zepto", [("milk", 2), ("bread", 1), ("eggs", 3)]),
    ("buy detergent on amazon", "order", "amazon", [("detergent", 1)]),
    ("reorder my usual", "order", None, []),
    ("what am I running out of?", "suggest", None, []),
    ("compare wireless earbuds", "search", None, [("wireless earbuds", 1)]),
])
def test_fallback_intent(text, intent, store, items):
    out = sa._fallback_intent(text)
    assert out["intent"] == intent and out["store"] == store
    assert [(i["name"], i["qty"]) for i in out["items"]] == items


def test_coordinator_routes_shopping_commands():
    assert select_agents("[shopping] order milk from zepto") == ["shopping"]
    assert select_agents("get my usual groceries") == ["shopping"]
    assert select_agents("what am I running out of") == ["shopping"]
    assert "shopping" not in select_agents("book a flight to Goa")


# ---------------------------------------------------------------- retraining
def _with_runtime(tmp_path):
    p = get_predictor()
    saved = (p.model, p.meta, p.runtime_dir)
    p.runtime_dir = tmp_path
    return p, saved


def _restore(p, saved):
    p.model, p.meta, p.runtime_dir = saved


def _dog_food_orders():
    asyncio.run(shopping_history.add_events(DEMO, [
        {"timestamp": f"2026-{m:02d}-{d:02d}T10:00:00", "action": "order", "name": "dog food", "app": "Amazon",
         "source": "store_history"} for m in (7, 8, 9) for d in (2, 10, 18, 26)]))


def test_retrain_is_checked_on_recent_purchases_before_use(tmp_path, monkeypatch):
    """A candidate that doesn't predict the held-out recent weeks better is NOT used."""
    p, saved = _with_runtime(tmp_path)
    try:
        _dog_food_orders()
        monkeypatch.setattr(sp, "_score", lambda m, rows, cats: {"logloss": 0.5, "precisionAt3": 0.5})
        result = asyncio.run(retrain_scheduler.run_now())
        assert result["status"] == "kept", result
        assert set(result["scores"]) == {"candidate", "current", "base"}
        assert p.model is saved[0] and not (tmp_path / "shopping_finetuned.txt").exists()
    finally:
        _restore(p, saved)


def test_better_retrain_is_promoted_with_backup(tmp_path, monkeypatch):
    p, saved = _with_runtime(tmp_path)
    try:
        _dog_food_orders()
        (tmp_path / "shopping_finetuned.txt").write_text("previous model")
        calls = iter([{"logloss": 0.30, "precisionAt3": 0.7},   # candidate
                      {"logloss": 0.40, "precisionAt3": 0.6},   # current
                      {"logloss": 0.45, "precisionAt3": 0.6}])  # base
        monkeypatch.setattr(sp, "_score", lambda m, rows, cats: next(calls))
        result = asyncio.run(retrain_scheduler.run_now())
        assert result["status"] == "trained", result
        assert (tmp_path / "shopping_finetuned_previous.txt").read_text() == "previous model"
        assert p.meta["status"] == "finetuned" and p.model.current_iteration() > p.base.current_iteration()
        r = p.predict(asyncio.run(shopping_history.get_events(DEMO)), pd.Timestamp(AS_OF))
        assert r["model"]["status"] == "finetuned"
    finally:
        _restore(p, saved)


def test_finetune_skips_without_enough_history():
    p = get_predictor()
    meta = p.meta
    out = p.finetune({"u": [{"timestamp": "2026-09-30T10:00", "action": "order", "name": "milk"}]},
                     pd.Timestamp(AS_OF), "test")
    assert out["status"] == "skipped"
    p.meta = meta


# ---------------------------------------------------------------- cart agent
def _req(elements, items=None, url="https://blinkit.com/s/?q=milk", history=None, step=1, store="Blinkit"):
    return sb.StepRequest(store=store, items=items or [sb.CartItem(name="milk", qty=1)], url=url,
                          elements=[sb.PageElement(**e) for e in elements], history=history or [], step=step)


def test_guard_blocks_payment_clicks_and_credentials():
    req = _req([{"id": "e1", "tag": "button", "text": "Proceed to Pay ₹240"},
                {"id": "e2", "tag": "input", "label": "Enter OTP"},
                {"id": "e3", "tag": "a", "text": "Continue", "href": "https://blinkit.com/checkout"}])
    assert sb.guard(sb.StepAction(action="click", elementId="e1"), req).action == "done"
    assert sb.guard(sb.StepAction(action="type", elementId="e2", text="1234"), req).action == "need_user"
    assert sb.guard(sb.StepAction(action="click", elementId="e3"), req).action == "done"
    assert sb.guard(sb.StepAction(action="navigate", url="https://www.amazon.in/gp/buy/spc"), req).action == "wait"
    assert sb.guard(sb.StepAction(action="navigate", url="http://blinkit.com/"), req).action == "wait"
    assert sb.guard(sb.StepAction(action="click", elementId="nope"), req).action == "wait"


def test_heuristic_adds_matching_product_when_llm_down(monkeypatch):
    async def down(messages, **kw):
        raise LLMServiceError("down")
    monkeypatch.setattr(sb.llm_service, "chat_json", down)
    req = _req([{"id": "e0", "tag": "div", "text": "ADD", "context": "Amul Gold Full Cream Milk 500 ml ₹34 ADD"},
                {"id": "e1", "tag": "div", "text": "ADD", "context": "Britannia Bread 400 g ₹50 ADD"}],
               items=[sb.CartItem(name="bread", qty=1)], url="https://blinkit.com/s/?q=bread")
    action = asyncio.run(sb.next_step(req))
    assert (action.action, action.elementId, action.source) == ("click", "e1", "fast")
    assert action.targetText == "add#0@britannia bread 400 g"


def test_llm_step_is_guarded_and_step_limited(monkeypatch):
    async def reckless(messages, **kw):
        return {"action": "click", "elementId": "e0", "reason": "finish order"}
    monkeypatch.setattr(sb.llm_service, "chat_json", reckless)
    req = _req([{"id": "e0", "tag": "button", "text": "Place Order"}])
    assert asyncio.run(sb.next_step(req)).action == "done"
    over = _req([], step=sb.MAX_STEPS_BASE + sb.MAX_STEPS_PER_ITEM + 1)
    assert asyncio.run(sb.next_step(over)).action == "done"


def test_browse_endpoints():
    assert client.get("/ai/shopping/browse/store", params={"name": "big basket"}).json()["key"] == "bigbasket"
    r = client.post("/ai/shopping/browse/step", json={
        "store": "Blinkit", "url": "https://blinkit.com/", "step": 999,
        "items": [{"name": "milk", "qty": 1, "status": "pending"}], "elements": []}).json()
    assert r["action"] == "done"


# ---------------------------------------------------------------- cart agent, app mode
def test_app_mode_refuses_urls_and_knows_packages():
    req = _req([{"id": "n0", "tag": "EditText", "editable": True, "label": "Search for products"}],
               url="com.grofers.customerapp.MainActivity")
    req.mode, req.appPackage = "app", "com.grofers.customerapp"
    assert sb.guard(sb.StepAction(action="navigate", url="https://blinkit.com/s/?q=milk"), req).action == "wait"
    assert sb.resolve_store("zepto")["androidPackage"] == "com.zeptoconsumerapp"
    assert sb.resolve_store("Swiggy Instamart")["appLabel"] == "Swiggy"
    assert sb.resolve_store("Lulu Hypermarket")["appLabel"] == "Lulu Hypermarket"


def test_app_mode_heuristic_searches_then_adds(monkeypatch):
    async def down(messages, **kw):
        raise LLMServiceError("down")
    monkeypatch.setattr(sb.llm_service, "chat_json", down)
    home = _req([{"id": "n0", "tag": "TextView", "text": 'Search "milk"'}], items=[sb.CartItem(name="bread", qty=2)])
    home.mode = "app"
    assert asyncio.run(sb.next_step(home)).model_dump(include={"action", "elementId"}) == {"action": "click", "elementId": "n0"}
    search = _req([{"id": "n0", "tag": "EditText", "editable": True}], items=[sb.CartItem(name="bread", qty=2)])
    search.mode = "app"
    a = asyncio.run(sb.next_step(search))
    assert (a.action, a.elementId, a.text, a.submit) == ("type", "n0", "bread", True)
    results = _req([{"id": "n3", "tag": "ViewGroup", "text": "ADD", "context": "Harvest Gold White Bread 400 g ₹45 ADD"}],
                   items=[sb.CartItem(name="bread", qty=2)])
    results.mode = "app"
    a = asyncio.run(sb.next_step(results))
    assert (a.action, a.elementId, a.targetText) == ("click", "n3", "add#0@harvest gold white bread 400 g")


def _hist(*recs):
    return [sb.StepRecord(action=a, target=t, result=r) for a, t, r in recs]


def test_add_is_verified_before_the_item_counts():
    curd = [sb.CartItem(name="milk", qty=1, status="added"), sb.CartItem(name="curd", qty=1)]
    clicked = [("click", "add#1@amul masti dahi (curd) 400 g", "clicked")]
    # ADD still there after the tap (e.g. a size sheet opened): not counted, the LLM decides
    still = _req([{"id": "n3", "tag": "ViewGroup", "text": "ADD", "context": "Amul Masti Dahi (Curd) 400 g ₹35 ADD"}],
                 items=curd, history=_hist(*clicked))
    still.mode = "app"
    assert sb.fast_step(still) is None
    # ADD replaced by a stepper: verified
    done = _req([{"id": "n3", "tag": "ViewGroup", "text": "1", "context": "Amul Masti Dahi (Curd) 400 g ₹35 − 1 +"}],
                items=curd, history=_hist(*clicked))
    done.mode = "app"
    a = sb.fast_step(done)
    assert (a.action, a.itemIndex, a.itemOk) == ("item_done", 1, True)


def test_quantity_uses_plus_then_finishes():
    items = [sb.CartItem(name="curd", qty=3)]
    after_add = _req([{"id": "n4", "tag": "ImageView", "label": "increase", "context": "Amul Masti Dahi (Curd) 400 g ₹35 − 1 +"}],
                     items=items, history=_hist(("click", "add#0@amul masti dahi (curd) 400 g", "clicked")))
    after_add.mode = "app"
    a = sb.fast_step(after_add)
    assert (a.action, a.elementId, a.repeat) == ("click", "n4", 2)
    after_plus = _req([], items=items, history=_hist(("click", a.targetText, "clicked 2x")))
    after_plus.mode = "app"
    assert sb.fast_step(after_plus).action == "item_done"


def test_generic_word_mid_name_is_left_to_the_llm():
    req = _req([{"id": "n1", "tag": "ViewGroup", "text": "ADD", "context": "Milk Bikis Biscuits 200 g ₹30 ADD"},
                {"id": "n2", "tag": "ViewGroup", "text": "ADD", "context": "Amul Taaza Toned Milk 500 ml ₹28 ADD"}],
               items=[sb.CartItem(name="milk", qty=1)])
    req.mode = "app"
    assert sb.fast_step(req).elementId == "n2"  # noun-last match wins over "Milk Bikis"
    only_bikis = _req([req.elements[0].model_dump()], items=[sb.CartItem(name="milk", qty=1)])
    only_bikis.mode = "app"
    assert sb.fast_step(only_bikis) is None or sb.fast_step(only_bikis).action != "click"


def test_open_cart_then_done_when_all_items_handled():
    items = [sb.CartItem(name="milk", status="added")]
    req = _req([{"id": "n9", "tag": "ViewGroup", "text": "1 item · View Cart"}], items=items)
    req.mode = "app"
    a = sb.fast_step(req)
    assert (a.action, a.elementId) == ("click", "n9")
    req.history = _hist(("click", "cart", "clicked"))
    assert sb.fast_step(req).action == "done"


def test_zepto_run_curd_then_milk():
    """Replays the phone run that added three curds and no milk: each item is added once and verified."""
    items = [sb.CartItem(name="curd"), sb.CartItem(name="milk")]
    results = [{"id": "n2", "tag": "ViewGroup", "text": "ADD",
                "context": "₹54 ₹80 Country Delight | Ghar Jaisa Dahi Cup 1 pc (400 g) ADD"},
               {"id": "n7", "tag": "ViewGroup", "text": "ADD", "context": "Nandini Curd Pouch, 1 pack (200 g), 4.8, (18k) ADD"},
               {"id": "n8", "tag": "ViewGroup", "text": "ADD", "context": "Milk Bikis Biscuits 200 g ₹30 ADD"}]
    req = _req(results, items=items)
    req.mode = "app"
    a = sb.fast_step(req)
    assert (a.action, a.elementId) == ("click", "n2") and a.targetText.startswith("add#0@country delight")
    # after the tap the Dahi Cup shows a stepper instead of ADD
    after = [{"id": "n2", "tag": "ViewGroup", "text": "1", "context": "₹54 ₹80 Country Delight | Ghar Jaisa Dahi Cup 1 pc (400 g) − 1 +"}] + results[1:]
    req = _req(after, items=items, history=_hist(("click", a.targetText, "clicked")))
    req.mode = "app"
    a = sb.fast_step(req)
    assert (a.action, a.itemIndex, a.itemOk) == ("item_done", 0, True)
    # milk is next: the curd tap must not count for milk, and Milk Bikis is not milk
    items[0].status = "added"
    req = _req(after + [{"id": "n9", "tag": "EditText", "editable": True, "text": "curd"}], items=items,
               history=_hist(("click", "add#0@country delight ghar jaisa dahi cup 1 pc (400 g)", "clicked")))
    req.mode = "app"
    a = sb.fast_step(req)
    assert (a.action, a.elementId, a.text) == ("type", "n9", "milk")


def test_llm_cannot_add_an_item_twice(monkeypatch):
    async def again(messages, **kw):
        return {"action": "click", "elementId": "n7", "reason": "add curd"}
    monkeypatch.setattr(sb.llm_service, "chat_json", again)
    items = [sb.CartItem(name="curd"), sb.CartItem(name="milk")]
    req = _req([{"id": "n2", "tag": "ViewGroup", "text": "1", "context": "Country Delight Dahi Cup 400 g − 1 +"},
                {"id": "n7", "tag": "ViewGroup", "text": "ADD", "context": "Nandini Curd Pouch 200 g ADD"},
                {"id": "n5", "tag": "ImageView", "label": "close"}], items=items,
               history=_hist(("click", "add#0@country delight dahi cup 400 g", "clicked"), ("click", "close", "clicked")))
    req.mode = "app"
    a = asyncio.run(sb.next_step(req))
    assert (a.action, a.itemIndex, a.itemOk) == ("item_done", 0, True)


def test_zepto_run_milk_size_picker():
    """Replays the run that tapped the milk ADD 20 times and then claimed milk was in the cart."""
    milk_card = {"id": "n3", "tag": "ViewGroup", "text": "ADD",
                 "context": "Amul Taaza Homogenised Toned Milk (Tetra Pack) 1 pack (200 ml) (1L) ADD"}
    items = [sb.CartItem(name="curd", status="added"), sb.CartItem(name="milk")]
    tap = "add#1@" + sb._product(sb.PageElement(**milk_card))
    taps = [("click", tap, "clicked")] * sb.MAX_ADD_TAPS
    req = _req([milk_card], items=items, history=_hist(*taps))
    req.mode = "app"
    a = sb.fast_step(req)
    assert (a.action, a.itemIndex, a.itemOk) == ("item_done", 1, False)  # gives up instead of tapping forever
    # on the cart screen (milk not shown at all) the earlier tap must NOT count as "added"
    cart = _req([{"id": "n1", "tag": "TextView", "text": "Country Delight | Ghar Jaisa Dahi Cup 1 pc (400 g)"}],
                items=items, history=_hist(("click", tap, "clicked"), ("click", "cart", "clicked")))
    cart.mode = "app"
    assert not sb._added_ok(cart, 1)
    items[1].status = "failed"
    assert sb._cart_summary(cart) == ("In your cart: curd. Not added: milk (add these yourself, or ask again).")


# ---------------------------------------------------------------- order history: read, remember, relate
from app.services import shopping_history_reader as reader  # noqa: E402
from app.services import shopping_memory as mem  # noqa: E402

REAL = "11111111-2222-3333-4444-555555555555"


@pytest.fixture
def memory_store(monkeypatch):
    """Supabase-shaped user, kept in memory."""
    store: dict[str, list[dict]] = {REAL: []}

    async def get_events(uid):
        return list(store.get(uid, []))

    async def add_events(uid, evs):
        store.setdefault(uid, []).extend(evs)
        return "memory"
    docs: dict[tuple, dict] = {}

    async def get_doc(uid, collection, doc_id):
        return docs.get((uid, collection, doc_id))

    async def set_doc(uid, collection, doc_id, data):
        docs[(uid, collection, doc_id)] = data
    monkeypatch.setattr(shopping_history, "get_events", get_events)
    monkeypatch.setattr(shopping_history, "add_events", add_events)
    monkeypatch.setattr(shopping_history, "get_doc", get_doc)
    monkeypatch.setattr(shopping_history, "set_doc", set_doc)
    return store


def test_history_phase_saves_orders_without_duplicates(monkeypatch, memory_store):
    async def reads(messages, **kw):
        return {"action": "back", "reason": "read order", "orders": [
            {"id": "#123", "date": "Yesterday", "items": [
                {"name": "Amul Taaza Toned Fresh Milk 500 ml", "qty": 2, "price": 56},
                {"name": "Country Delight Ghar Jaisa Dahi Cup 400 g", "qty": 1, "price": 54}]}]}
    monkeypatch.setattr(reader.llm_service, "chat_json", reads)
    req = sb.StepRequest(mode="app", phase="history", store="Zepto", userId=REAL, url="OrderDetail", step=5)
    a = asyncio.run(sb.next_step(req))
    assert (a.action, a.ordersSaved) == ("back", 1)
    a = asyncio.run(sb.next_step(req))  # same order on screen again
    assert a.ordersSaved == 0
    saved = [e for e in memory_store[REAL] if e["action"] == "order"]
    assert [(e["item"], e["qty"], e["app"], e["source"]) for e in saved] == [
        ("milk", 2.0, "Zepto", "store_history"), ("curd", 1.0, "Zepto", "store_history")]
    assert saved[0]["price"] == 28.0  # per unit


def test_history_phase_is_read_only(monkeypatch, memory_store):
    async def reorder(messages, **kw):
        return {"action": "click", "elementId": "n1", "reason": "reorder", "orders": []}
    monkeypatch.setattr(reader.llm_service, "chat_json", reorder)
    req = sb.StepRequest(mode="app", phase="history", store="Zepto", userId=REAL, url="Orders", step=3,
                         elements=[sb.PageElement(id="n1", tag="Button", text="Reorder")])
    assert asyncio.run(sb.next_step(req)).action != "click"


def test_history_done_marks_store_synced_then_items_resolve_to_usual(memory_store):
    memory_store[REAL] += [
        {"timestamp": f"2026-09-{d:02d}T12:00:00", "action": "order", "name": "Amul Taaza Toned Fresh Milk 500 ml",
         "qty": 2, "app": "Zepto", "source": "store_history"} for d in (3, 10, 17, 24)]
    req = sb.StepRequest(mode="app", phase="history", store="Zepto", userId=REAL, url="Orders", historyLimit=8, ordersRead=8,
                         items=[sb.CartItem(name="milk"), sb.CartItem(name="eggs 12 pcs")])
    a = asyncio.run(sb.next_step(req))
    assert a.action == "history_done"
    assert not mem.needs_sync(memory_store[REAL], "Zepto") and mem.needs_sync(memory_store[REAL], "Blinkit")
    req.phase, req.resolved = "cart", False
    a = asyncio.run(sb.next_step(req))
    assert a.action == "set_items"
    assert a.items == [{"name": "Amul Taaza Toned Fresh Milk 500 ml", "qty": 2}, {"name": "eggs 12 pcs", "qty": 1}]


def test_command_relates_to_history(monkeypatch, memory_store):
    memory_store[REAL] += [
        {"timestamp": f"2026-09-{d:02d}T12:00:00", "action": "order", "name": n, "qty": q, "app": "Zepto",
         "source": "store_history"}
        for d in (5, 15, 25) for n, q in (("Country Delight Ghar Jaisa Dahi Cup 400 g", 1),
                                          ("Amul Taaza Toned Fresh Milk 500 ml", 2))]
    memory_store[REAL].append({"timestamp": _days_ago(1), "action": "history_sync", "name": "order history",
                               "app": "Zepto", "source": "store_history"})
    seen = {}

    async def intent(messages, **kw):
        seen["prompt"] = messages[0]["content"]
        return {"intent": "order", "store": "zepto", "items": [{"name": "curd", "qty": 1}, {"name": "milk", "qty": 1}]}
    monkeypatch.setattr(sa.llm_service, "chat_json", intent)
    r = client.post("/ai/shopping/ask", json={"userId": REAL, "message": "order curd and milk from zepto"}).json()
    assert "Country Delight Ghar Jaisa Dahi Cup 400 g" in seen["prompt"]  # the LLM sees their usual products
    job = r["data"]["cartOrder"]
    assert job["syncHistory"] is False and job["resolved"] is True
    assert job["items"] == [{"name": "Country Delight Ghar Jaisa Dahi Cup 400 g", "qty": 1},
                            {"name": "Amul Taaza Toned Fresh Milk 500 ml", "qty": 2}]


def test_repeated_test_commands_count_once():
    ev = [{"timestamp": f"2026-10-01T21:{m:02d}", "action": "order", "name": "milk", "source": "agent_command"}
          for m in (0, 10, 39, 52)]
    out = normalize_events(ev)
    assert (out["action"] == "order").sum() == 0  # commands are intent (cart adds), never purchases


@pytest.mark.parametrize("raw,expected", [("Yesterday", "2026-10-01"), ("3 days ago", "2026-09-29"),
                                          ("28 Sep", "2026-09-28"), ("15 Dec", "2025-12-15"),
                                          ("2026-08-30", "2026-08-30")])
def test_order_dates(raw, expected):
    from datetime import date
    assert mem._order_date(raw, date(2026, 10, 2)) == expected


@pytest.mark.parametrize("name,item", [
    ("Sid's Farm Family Tub Curd - made from tested milk (no antibiotics)", "curd"),
    ("Haldiram's Mixture | Crunchy Savory Snack 1 pack (200 g)", "chips"),
    ("Lay's Spanish Tomato Tango Flavour | Potato Chips, 1 pack (48 g or 58 g)", "chips"),
    ("English Oven Milk Bread 1 pack (400 g)", "bread"),
    ("Nissin Geki - Spicy Kimchi Korean Ramen Noodles 1 pack (80 g)", "instant noodles"),
    ("Heritage Cheese Slices 1 pack (100 g)", "cheese"),
    ("Country Delight | Ghar Jaisa Dahi Cup 1 pc (400 g)", "curd"),
])
def test_real_zepto_product_names(name, item):
    assert canonical_item(name) == item


def test_milk_is_not_a_curd_made_from_milk():
    """The run that added "Sid's Farm Curd - made from tested milk" for milk."""
    items = [sb.CartItem(name="curd", status="added"), sb.CartItem(name="milk")]
    req = _req([{"id": "n3", "tag": "ViewGroup", "text": "ADD",
                 "context": "Sid's Farm Family Tub Curd - made from tested milk (no antibiotics . no hormones) ADD"},
                {"id": "n5", "tag": "ViewGroup", "text": "ADD", "context": "Amul Taaza Toned Fresh Milk 500 ml ₹28 ADD"}],
               items=items)
    req.mode = "app"
    assert sb.fast_step(req).elementId == "n5"


def test_usual_needs_a_real_specific_product():
    events = [{"timestamp": "2026-10-01T21:00", "action": "order", "name": "milk", "app": "Zepto", "source": "agent_command"},
              {"timestamp": "2026-09-25T12:00", "action": "order", "name": "For Your Eyes Only 1 pc", "price": 0,
               "app": "Zepto", "source": "store_history"}]
    items, notes = mem.resolve_items([{"name": "milk", "qty": 1}], mem.product_profile(events))
    assert items == [{"name": "milk", "qty": 1}] and notes == []  # "milk" from a test command is no "usual"


def test_free_gifts_are_not_purchases():
    from datetime import date
    evs = mem.imported_events([{"date": "2026-07-18", "items": [
        {"name": "English Oven Milk Bread 1 pack (400 g)", "qty": 1, "price": 60},
        {"name": "For Your Eyes Only 1 pc", "qty": 1, "price": 0}]}], "Zepto", [], date(2026, 10, 2))
    assert [e["item"] for e in evs] == ["bread"]


def test_resync_stops_when_it_reaches_orders_already_read(memory_store):
    memory_store[REAL].append({"timestamp": "2026-09-20T10:00:00", "action": "history_sync", "app": "Zepto",
                               "name": "order history", "source": "store_history"})
    req = sb.StepRequest(mode="app", phase="history", store="Zepto", userId=REAL, url="Orders", ordersRead=3,
                         ordersKnown=2, historyLimit=8)
    a = asyncio.run(sb.next_step(req))
    assert a.action == "history_done" and "caught up" in a.reason


def test_full_sync_reads_more_than_the_quick_look(monkeypatch, memory_store):
    async def reads(messages, **kw):
        return {"action": "back", "orders": [{"id": "#9", "date": "2026-06-01",
                                               "items": [{"name": "Tata Salt 1 kg", "qty": 1, "price": 28}]}]}
    monkeypatch.setattr(reader.llm_service, "chat_json", reads)
    req = sb.StepRequest(mode="app", phase="history", store="Blinkit", userId=REAL, url="Orders", ordersRead=12,
                         historyLimit=30, step=20)
    a = asyncio.run(sb.next_step(req))
    assert (a.action, a.ordersSaved) == ("back", 1)
    a = asyncio.run(sb.next_step(req))
    assert (a.ordersSaved, a.ordersKnown) == (0, 1)


def test_first_sync_does_not_stop_on_repeated_orders(monkeypatch, memory_store):
    """First time reading a store: seeing an order twice (list, then detail) must not end the sync."""
    async def nav(messages, **kw):
        return {"action": "click", "elementId": "n1", "reason": "open next order", "orders": []}
    monkeypatch.setattr(reader.llm_service, "chat_json", nav)
    req = sb.StepRequest(mode="app", phase="history", store="Amazon", userId=REAL, url="Orders", ordersRead=3,
                         ordersKnown=2, historyLimit=30, elements=[sb.PageElement(id="n1", tag="View", text="Order 4")])
    assert asyncio.run(sb.next_step(req)).action == "click"


def test_orders_without_a_date_are_skipped_and_respaced_names_are_duplicates():
    from datetime import date
    today = date(2026, 10, 3)
    first = mem.imported_events([{"id": "#403-1", "date": "2026-09-20", "items": [{"name": "Lay's Magic Masala 48 g", "qty": 1}]},
                                 {"id": None, "date": None, "items": [{"name": "Amul Milk Gold 1 L", "qty": 1}]}],
                                "Amazon", [], today)
    assert [e["name"] for e in first] == ["Lay's Magic Masala 48 g"]          # undated order not invented
    again = mem.imported_events([{"id": "403-1", "date": "2026-09-21", "items": [{"name": "Lay's Magic Masala 48g", "qty": 1}]}],
                                "Amazon", first, today)
    assert again == []                                                         # same order id + same product


def test_invoices_are_parsed_locally():
    from app.services.invoice_parser import order_events, parse_invoice
    tax = """Tax Invoice
ORIGINAL FOR RECIPIENT
Restaurant Name: Pizza Place
Invoice Date: 03/07/2026
Customer Name: Someone Private
Delivery Address: Somewhere Private
Particulars Gross value Discount Net value CGST (Rate) CGST (INR) SGST (Rate) SGST (INR) Total
1 x Create Your Flavour Fun
230 25.30 204.70 2.50% 5.12 2.50% 5.12 214.94
Combo - Box Of 2 - Veg Pizza
2 x Garlic Bread 138 38.00 100.00 2.50% 2.50 2.50% 2.50 105.00
Item(s) Total 368.00 63.30 304.70 7.62 7.62 319.94
Amount of INR 319.94 settled digitally against Order ID 1234567890 dated 2026-07-03.
For ETERNAL LIMITED (FORMERLY KNOWN AS ZOMATO LIMITED)"""
    o = parse_invoice(tax)
    assert (o["store"], o["orderId"], o["restaurant"], o["timestamp"][:10]) == ("Zomato", "1234567890", "Pizza Place", "2026-07-03")
    assert [(i["name"], i["qty"], i["price"]) for i in o["items"]] == [
        ("Create Your Flavour Fun Combo - Box Of 2 - Veg Pizza", 1, 204.7), ("Garlic Bread", 2, 50.0)]
    assert "Private" not in str(o)                                             # no personal details kept
    receipt = """Zomato Food Order: Summary and Receipt
Order ID: 1098765432
Order Time: 02 October 2026, 10:25 AM
Customer Name: Someone Private
Restaurant Name: Spice Kitchen
Item Quantity Unit Price Total Price
2 Aloo Paratha with Curd and Pickle 1 ₹139 ₹139
Soya Chaap Biriyani Bowl 1 229 229
₹ ₹
3-month Zomato Gold membership ₹1
Taxes ₹10.34"""
    o = parse_invoice(receipt)
    assert o["timestamp"] == "2026-10-02T10:25:00"
    assert [i["name"] for i in o["items"]] == ["2 Aloo Paratha with Curd and Pickle", "Soya Chaap Biriyani Bowl"]
    evs = order_events(o, [])
    assert evs[0]["category"] == "restaurant_food" and evs[0]["restaurant"] == "Spice Kitchen"
    assert order_events(o, evs) == []                                          # re-import adds nothing
    assert parse_invoice("some other document") is None


def test_restaurant_dishes_are_not_groceries_and_resolve_with_restaurant():
    events = [{"timestamp": f"2026-0{m}-{d:02d}T21:00:00", "action": "order", "name": "Soya Chaap Biriyani Bowl",
               "app": "Zomato", "category": "restaurant_food", "restaurant": "Biryani House", "source": "invoice"}
              for m, d in ((6, 20), (6, 24), (7, 3), (9, 29))]
    events.append({"timestamp": "2026-10-01T10:00:00", "action": "order", "name": "2 Aloo Paratha with Curd and Pickle",
                   "app": "Zomato", "category": "restaurant_food", "restaurant": "Spice Kitchen", "source": "invoice"})
    ev = normalize_events(events)
    assert set(ev["item"]) == {"soya chaap biriyani bowl", "2 aloo paratha with curd and pickle"}  # not potatoes/curd
    items, notes = mem.resolve_items([{"name": "soya chaap biryani", "qty": 1}], mem.product_profile(events), store="zomato")
    assert items[0]["name"] == "Soya Chaap Biriyani Bowl" and items[0]["hint"] == "from restaurant Biryani House"
    # on Zomato the same dish at another restaurant is not a confident match; the user's restaurant is
    req = _req([{"id": "n1", "tag": "ViewGroup", "text": "ADD", "context": "Soya Chaap Biriyani Bowl ₹249 Hyderabad House ADD"},
                {"id": "n2", "tag": "ViewGroup", "text": "ADD", "context": "Biryani House Soya Chaap Biriyani Bowl ₹229 ADD"}],
               items=[sb.CartItem(name="Soya Chaap Biriyani Bowl", hint="from restaurant Biryani House")], store="Zomato")
    req.mode, req.pageText = "app", ""
    assert sb.fast_step(req).elementId == "n2"


@pytest.mark.parametrize("heard,store,package", [
    ("blink it", "Blinkit", "com.grofers.customerapp"), ("zapdo", "Zepto", "com.zeptoconsumerapp"),
    ("Zapto", "Zepto", "com.zeptoconsumerapp"), ("the blinkit app", "Blinkit", "com.grofers.customerapp"),
    ("insta mart", "Swiggy Instamart", "in.swiggy.android"), ("jomato", "Zomato", "com.application.zomato"),
    ("Lulu Hypermarket", "Lulu Hypermarket", None),
])
def test_misheard_store_names_still_open_the_real_app(heard, store, package):
    """Voice commands write stores as "blink it" / "zapdo"; they must not fall back to a web search."""
    r = sb.resolve_store(heard)
    assert (r["name"], r["androidPackage"]) == (store, package)


def test_search_is_not_retyped_while_results_load():
    """Zomato run that looped type -> scroll -> type: after typing, the fast path leaves the next move to the LLM."""
    item = sb.CartItem(name="Soya Chaap Biriyani Bowl", hint="from restaurant Biryani House")
    req = _req([{"id": "n1", "tag": "EditText", "editable": True, "text": ""}], items=[item], store="Zomato",
               history=_hist(("type", "search@Soya Chaap Biriyani Bowl", "typed + enter"), ("scroll", None, "scrolled")))
    req.mode = "app"
    assert sb.fast_step(req) is None


def test_llm_service_passes_options_through_and_falls_back(monkeypatch):
    """Exercises the real LLMService wrapper (other tests replace chat_json wholesale)."""
    from app.core.config import settings
    from app.services.llm_service import LLMProvider, LLMService

    calls = []

    class Fake(LLMProvider):
        model = "main-model"

        async def chat(self, messages, *, json_mode=False, max_tokens=None, model=None, timeout=60, retries=3):
            calls.append((model, max_tokens, json_mode))
            if model is None:
                raise LLMServiceError("main model retired")
            return '{"ok": true}'

    svc = LLMService(Fake())
    monkeypatch.setattr(settings, "llm_provider", "nvidia")
    monkeypatch.setattr(settings, "llm_fallback_models", "backup-a,backup-b")
    assert asyncio.run(svc.chat_json([{"role": "user", "content": "x"}], max_tokens=50)) == {"ok": True}
    assert calls == [(None, 50, True), ("backup-a", 50, True)]            # main failed -> first backup answered
    calls.clear()
    assert asyncio.run(svc.chat([{"role": "user", "content": "x"}], max_tokens=20, model="backup-b")) == '{"ok": true}'
    assert calls == [("backup-b", 20, False)]
    monkeypatch.setattr(settings, "llm_provider", "openrouter")           # backups are NVIDIA ids: not used elsewhere
    calls.clear()
    with pytest.raises(LLMServiceError):
        asyncio.run(svc.chat([{"role": "user", "content": "x"}]))
    assert calls == [(None, settings.llm_default_max_tokens, False)]


# ---------------------------------------------------------------- decision engine: ask, compare, learn, rules
from app.shopping import engine as eng  # noqa: E402
from app.shopping.policy import AutoOrderRule, ShoppingPolicy  # noqa: E402
from app.shopping.preferences import build_preferences, learn_weights, normalize_product, same_product  # noqa: E402
from app.shopping.providers import registry  # noqa: E402


def _milk_history(store, zepto_days=(2, 4, 6, 8, 10, 12, 14, 16), blinkit_days=(1,)):
    """Amul Taaza 1 L at ₹67 on Zepto (a strong habit by default) and ₹68 on Blinkit."""
    rows = [("Zepto", d, 67) for d in zepto_days] + [("Blinkit", d, 68) for d in blinkit_days]
    store[REAL] += [{"timestamp": f"2026-09-{d:02d}T09:00:00", "action": "order", "name": "Amul Taaza Toned Milk 1 L",
                     "qty": 1, "price": price, "app": app, "source": "store_history"} for app, d, price in rows]
    for app in ("Zepto", "Blinkit"):
        store[REAL].append({"timestamp": _days_ago(1), "action": "history_sync", "app": app,
                            "name": "order history", "source": "store_history"})


def _ask(message, monkeypatch, intent=None):
    async def llm(messages, **kw):
        if intent is None:
            raise LLMServiceError("offline")
        return intent
    monkeypatch.setattr(sa.llm_service, "chat_json", llm)
    return client.post("/ai/shopping/ask", json={"userId": REAL, "message": message}).json()["data"]


def test_same_product_across_stores():
    a = normalize_product("Amul Taaza Homogenised Toned Milk 1L")
    b = normalize_product("Amul Taaza Milk 1 L")
    c = normalize_product("Amul Taaza Toned Milk 500 ml")
    assert (a["brand"], a["category"], a["quantity"]) == ("Amul", "milk", "1 l")
    assert same_product(a, b) and not same_product(a, c)
    assert not same_product(a, normalize_product("Nandini Toned Milk 1 L"))


def test_providers_are_data_not_code():
    assert {"Blinkit", "Zepto", "Swiggy Instamart"} <= {p.name for p in registry.for_category("dairy")}
    assert [p.name for p in registry.for_category("restaurant_food")] == ["Zomato", "Swiggy", "Domino's"]
    assert [p.name for p in registry.for_category("dairy", installed={"zapdo", "Amazon"})] == ["Zepto"]
    r = asyncio.run(registry.get("Zepto").search("milk"))
    assert r.status == "not_checked" and r.offers == []        # no API: it says so, it doesn't invent a price


def test_known_item_usual_store_needs_one_yes(monkeypatch, memory_store):
    _milk_history(memory_store)
    d = _ask("order milk", monkeypatch)
    a = d["assist"]
    assert "cartOrder" not in d and a["question"] == "confirm" and a["level"] == 2
    assert "Zepto" in a["say"] and "you last paid ₹67 there" in a["say"] and a["quickReplies"] == ["Yes", "No"]
    d = _ask("yes", monkeypatch)
    assert d["cartOrder"]["store"] == "Zepto"
    assert d["cartOrder"]["items"] == [{"name": "Amul Taaza Toned Milk 1 L", "qty": 1}]     # their usual product
    decision = next(e for e in memory_store[REAL] if e["action"] == "decision")
    assert (decision["item"], decision["chosen"]) == ("milk", "Zepto")
    assert {o["provider"] for o in decision["options"]} >= {"Zepto", "Blinkit"}


def test_two_usual_stores_shows_both_and_asks_which(monkeypatch, memory_store):
    """No clear favourite (Zepto 4x, Blinkit 2x): show both with the real prices and ask, don't assume."""
    _milk_history(memory_store, zepto_days=(2, 6, 10, 14), blinkit_days=(20, 24))
    a = _ask("order milk", monkeypatch)["assist"]
    assert a["question"] == "choose_provider" and a["quickReplies"][:2] == ["Zepto", "Blinkit"]
    assert "your usual Amul Taaza Toned Milk 1 L" in a["say"]
    assert "Zepto — you last paid ₹67 there" in a["say"] and "Blinkit — you last paid ₹68 there" in a["say"]
    assert "Swiggy Instamart — price not checked yet" in a["say"]
    d = _ask("the cheaper one", monkeypatch)
    assert d["cartOrder"]["store"] == "Zepto" and "what you last paid at each" in d["assist"]["say"]


def test_cheaper_one_uses_real_prices_and_says_where_they_came_from(monkeypatch, memory_store):
    _milk_history(memory_store)
    _ask("order milk", monkeypatch)
    d = _ask("actually blinkit", monkeypatch)                       # a store name overrides the suggestion
    assert d["cartOrder"]["store"] == "Blinkit"
    sessions.clear(REAL)
    _ask("order milk", monkeypatch)
    d = _ask("get the cheaper one", monkeypatch)
    assert d["cartOrder"]["store"] == "Zepto"
    assert "what you last paid at each" in d["assist"]["say"] and "₹67" in d["assist"]["say"]


def test_new_product_shows_options_without_inventing_numbers(monkeypatch, memory_store):
    d = _ask("buy shampoo", monkeypatch)
    a = d["assist"]
    assert "cartOrder" not in d and a["question"] == "choose_provider" and a["level"] == 1
    assert all(o["final_cost"] is None and o["eta_minutes"] is None and o["source"] == "not_checked" for o in a["options"])
    assert "haven't read their prices yet" in a["say"] and "can't say which is cheapest" in a["say"]
    d = _ask("the cheapest one", monkeypatch)                       # no prices to compare: say so, keep asking
    assert "cartOrder" not in d and "don't have prices" in d["assist"]["say"] and d["assist"]["pending"]
    d = _ask("zapdo", monkeypatch)                                  # speech spelling of Zepto
    assert d["cartOrder"]["store"] == "Zepto"


def test_no_cancels_and_new_order_replaces_pending_question(monkeypatch, memory_store):
    _milk_history(memory_store)
    _ask("order milk", monkeypatch)
    d = _ask("no leave it", monkeypatch)
    assert "cartOrder" not in d and not d["assist"]["pending"] and sessions.get(REAL) is None
    _ask("order milk", monkeypatch)
    d = _ask("order bread from blinkit", monkeypatch)               # a new request, not an answer about milk
    assert "bread" in d["assist"]["say"].lower() and "milk" not in d["assist"]["say"].lower()


def test_purchase_rules(monkeypatch, memory_store):
    _milk_history(memory_store)
    r = client.put("/ai/shopping/policy", params={"userId": REAL}, json={
        "allow_auto_repeat_orders": True,
        "auto_order_rules": [{"item": "milk", "provider": "Zepto", "max_price": 75, "max_qty": 2}]}).json()
    assert r["allow_auto_repeat_orders"] and r["require_confirmation_above"] == 1000
    d = _ask("order milk", monkeypatch)                             # level 3: inside the rule, no question
    assert d["cartOrder"]["store"] == "Zepto" and d["assist"]["level"] == 3
    d = _ask("order 3 milk", monkeypatch)                           # outside the rule (qty): ask
    assert "cartOrder" not in d and d["assist"]["pending"]
    sessions.clear(REAL)
    policy = ShoppingPolicy(allow_auto_repeat_orders=True, auto_order_rules=[AutoOrderRule(item="milk", max_price=60)])
    from app.shopping.policy import auto_rule, confirmation_reasons
    assert auto_rule(policy, item="milk", provider="Zepto", qty=1, unit_price=67, known=True) is None   # price cap
    assert auto_rule(policy, item="milk", provider="Zepto", qty=1, unit_price=None, known=True) is None  # unverifiable
    reasons = confirmation_reasons(ShoppingPolicy(), known=True, total=1500, unit_price=90, typical_price=67)
    assert len(reasons) == 2 and "above your ₹1,000 limit" in reasons[0] and "above what you usually pay" in reasons[1]


def test_speed_versus_price_is_learnt_from_choices():
    def choice(chosen):
        return {"action": "decision", "chosen": chosen, "options": [
            {"provider": "BigBasket", "final_cost": 65, "eta_minutes": 900},
            {"provider": "Blinkit", "final_cost": 68, "eta_minutes": 10}]}
    price_w, speed_w, conf, n = learn_weights([])
    assert (price_w, speed_w, conf, n) == (0.5, 0.5, 0.0, 0)                       # no evidence: neutral
    price_w, speed_w, conf, n = learn_weights([choice("Blinkit")] * 6 + [choice("BigBasket")])
    assert speed_w > 0.7 and price_w < 0.3 and conf > 0.7 and n == 7               # pays ₹3 more to get it now
    prefs = build_preferences([choice("Blinkit")] * 6)
    fast = eng.Option(provider="Blinkit", label="Blinkit", final_cost=68, eta_minutes=10)
    cheap = eng.Option(provider="BigBasket", label="BigBasket", final_cost=65, eta_minutes=900)
    assert eng.rank([cheap, fast], prefs)[0].provider == "Blinkit"
    assert eng.rank([cheap, fast], prefs, "cheapest")[0].provider == "BigBasket"   # unless they ask for cheapest


def test_replies_are_understood():
    s = sessions.start("u")
    s.pending = "choose_provider"
    s.options = [eng.Option(provider="Blinkit", label="Blinkit", final_cost=68),
                 eng.Option(provider="Zepto", label="Zepto", final_cost=67)]
    kind = lambda t: eng.interpret(t, s)  # noqa: E731
    assert kind("go with zepto")[1].provider == "Zepto" and kind("the second one")[1].provider == "Zepto"
    assert kind("option 2")[1].provider == "Zepto" and kind("number one")[1].provider == "Blinkit"
    assert kind("buy the ₹67 one")[1].provider == "Zepto" and kind("blink it")[1].provider == "Blinkit"
    assert kind("the cheapest one") == ("criterion", "cheapest") and kind("fastest delivery") == ("criterion", "fastest")
    assert kind("whatever I usually buy") == ("criterion", "usual") and kind("get the same one from last time")[0] == "criterion"
    assert kind("don't care, just order it") == ("any", None)
    assert kind("yes please") == ("yes", None) and kind("nahi") == ("no", None) and kind("hmm what")[0] == "unknown"
    sessions.clear("u")


def test_chat_speaks_the_agents_question_and_routes_the_answer(monkeypatch, memory_store):
    _milk_history(memory_store)

    async def llm(messages, **kw):
        raise LLMServiceError("offline")
    monkeypatch.setattr(sa.llm_service, "chat_json", llm)
    r = client.post("/ai/chat", json={"userId": REAL, "message": "order milk"}).json()
    assert "Shall I add it to your cart?" in r["reply"] and "cartOrder" not in r["agentData"]["shopping"]
    r = client.post("/ai/chat", json={"userId": REAL, "message": "yes"}).json()        # no shopping keyword: still routed
    assert r["agentsConsulted"] == ["shopping"] and r["agentData"]["shopping"]["cartOrder"]["store"] == "Zepto"


def test_store_from_history_is_not_treated_as_named(monkeypatch, memory_store):
    """'I need milk quickly' names no store: a store the intent model lifts from history must not skip the
    question, and with no delivery times read, 'fastest' is answered honestly."""
    _milk_history(memory_store)
    d = _ask("I need milk quickly", monkeypatch, intent={"intent": "order", "store": "Zepto",
                                                         "items": [{"name": "milk", "qty": 1}]})
    a = d["assist"]
    assert "cartOrder" not in d and a["question"] == "confirm"
    assert "haven't read delivery times live" in a["say"] and "quick-delivery app" in a["say"]
    assert sa._store_in_message("order milk from zapdo", "Zepto") == "Zepto"
    assert sa._store_in_message("order rice from lulu", "Lulu Hypermarket") == "Lulu Hypermarket"
    assert sa._store_in_message("order milk", "Zepto") is None


def test_history_reading_gives_up_when_stuck_so_the_order_goes_ahead():
    from app.services import shopping_history_reader as hr
    tap = sb.StepAction(action="click", elementId="n56", targetText="open: ")
    same_tap_twice = [sb.StepRecord(action="click", target="open: "), sb.StepRecord(action="click", target="open: ")]
    req = sb.StepRequest(mode="app", phase="history", store="Blinkit", url="Account", step=3, history=same_tap_twice)
    assert hr._stuck(req, tap)                                                    # third identical tap: give up
    assert not hr._stuck(sb.StepRequest(mode="app", phase="history", store="Blinkit", url="Account", step=3,
                                        history=same_tap_twice[:1]), tap)         # second one: still trying
    other = sb.StepAction(action="click", elementId="n12", targetText="open: Orders")
    assert not hr._stuck(req, other)                                              # a different tap is progress
    assert hr._stuck(sb.StepRequest(mode="app", phase="history", store="Blinkit", url="Account", step=8, ordersRead=0), other)
    assert not hr._stuck(sb.StepRequest(mode="app", phase="history", store="Blinkit", url="Account", step=8, ordersRead=2), other)


def test_restaurant_food_goes_to_food_delivery_apps_not_grocery_stores(memory_store):
    from app.ml.shopping_catalog import is_prepared_food
    assert is_prepared_food("pizza") and is_prepared_food("a chicken burger") and is_prepared_food("veg biryani")
    assert not is_prepared_food("pizza base") and not is_prepared_food("burger buns") and not is_prepared_food("milk")

    def ask(message, uid=REAL):
        r = asyncio.run(sa.ShoppingAgent().run(message, {"userId": uid}))
        return r.data.get("assist"), r.data

    for dish in ("order a pizza", "order a burger for me"):
        sa.sessions.clear(REAL)
        a, d = ask(dish)
        assert a["question"] == "choose_provider" and "cartOrder" not in d          # asks, never guesses a store
        assert "Zomato" in a["say"] and "Swiggy" in a["say"] and "Domino's" in a["say"]
        assert "Blinkit" not in a["say"] and "Amazon" not in a["say"]                # not grocery / marketplace
    a, d = ask("zomato")                                                             # the answer to "which one?"
    assert d["cartOrder"]["store"] == "Zomato" and d["cartOrder"]["items"][0]["name"] == "burger"

    sa.sessions.clear(REAL)
    ask("order a burger")
    a, d = ask("swiggy")
    assert d["cartOrder"]["store"] == "Swiggy"                                       # the food side, not Instamart

    sa.sessions.clear(REAL)
    a, d = ask("order milk from swiggy")                                             # groceries: Swiggy's grocery side
    assert "Swiggy Instamart" in a["say"]

    sa.sessions.clear(REAL)
    a, d = ask("order pizza base and burger buns")                                   # packaged: grocery stores
    assert "Blinkit" in a["say"] and "Zomato" not in a["say"]
    sa.sessions.clear(REAL)
