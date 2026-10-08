"""Screen agent: step validation (safety), the endpoint, and visual product search. Offline: the LLM and the shop are mocked."""
from __future__ import annotations

import asyncio

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import screen_agent as sa
from app.services.llm_service import LLMServiceError
from app.services.shopping_service import ShoppingResult, ShoppingServiceError

client = TestClient(app)


def run(coro):
    return asyncio.run(coro)

ELEMENTS = [
    {"id": "n0", "tag": "Button", "text": "Like", "role": "like_button"},
    {"id": "n1", "tag": "Button", "text": "Send"},
    {"id": "n2", "tag": "EditText", "text": "", "label": "Search", "editable": True},
    {"id": "n3", "tag": "EditText", "text": "", "editable": True, "type": "password"},
    {"id": "n4", "tag": "Button", "text": "Pay now"},
    {"id": "n5", "tag": "Button", "text": "ADD", "context": "Amul Toned Milk 500 ml ₹29"},
    {"id": "n6", "tag": "Button", "text": "Share"},
    {"id": "n7", "tag": "Button", "text": "ADD", "context": "Place order and pay ₹499 using UPI"},
]
JPEG = "/9j/" + "A" * 200


def step(raw, goal="like this post"):
    return sa.validate_step(raw, ELEMENTS, goal)


def test_click_on_a_real_element_is_allowed_and_not_risky():
    r = step({"action": "click", "elementId": "n0"})
    assert r["action"] == "click" and r["elementId"] == "n0" and r["risky"] is False


def test_unknown_element_is_never_clicked():
    r = step({"action": "click", "elementId": "n99"})
    assert r["action"] == "need_user"


def test_payment_controls_are_refused_even_when_asked():
    assert step({"action": "click", "elementId": "n4"}, "pay now")["action"] == "need_user"
    # an unlabeled-looking ADD next to "Place order and pay" is a payment step too
    assert step({"action": "click", "elementId": "n7"}, "add it")["action"] == "need_user"


def test_a_normal_add_next_to_a_product_is_fine():
    assert step({"action": "click", "elementId": "n5"}, "add the milk")["action"] == "click"


def test_send_is_always_confirmed_even_if_the_user_said_send():
    assert step({"action": "click", "elementId": "n1"}, "send it")["risky"] is True


def test_share_is_confirmed_unless_the_user_asked_for_it():
    assert step({"action": "click", "elementId": "n6"}, "open the menu")["risky"] is True
    assert step({"action": "click", "elementId": "n6"}, "share this post")["risky"] is False


def test_never_types_into_passwords_or_non_fields():
    assert step({"action": "type", "elementId": "n3", "text": "hunter2"})["action"] == "need_user"
    assert step({"action": "type", "elementId": "n0", "text": "x"})["action"] == "need_user"


def test_type_into_a_search_box():
    r = step({"action": "type", "elementId": "n2", "text": "blue shoes", "submit": True})
    assert r == {"action": "type", "elementId": "n2", "text": "blue shoes", "submit": True, "reason": "", "risky": False}


def test_garbage_action_becomes_a_request_for_help():
    assert step({"action": "format_phone"})["action"] == "need_user"
    assert step({})["action"] == "need_user"


def test_scroll_drops_an_unknown_element_id():
    assert step({"action": "scroll", "elementId": "zzz"})["elementId"] is None
    assert step({"action": "scroll", "elementId": "n0"})["elementId"] == "n0"


def test_done_always_has_something_to_say():
    assert step({"action": "done"})["message"]


def test_next_step_stops_when_stuck_or_over_the_step_limit(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("the model must not be called")
    monkeypatch.setattr(sa.llm_service, "chat_json", boom)
    same = [{"action": "click", "target": "Like"}] * 3
    assert run(sa.next_step("g", "app", ELEMENTS, "", same, 3))["action"] == "need_user"
    assert run(sa.next_step("g", "app", ELEMENTS, "", [], 14))["action"] == "need_user"


def test_next_step_uses_the_vision_model_only_with_a_screenshot(monkeypatch):
    calls = []

    async def text_model(messages, **k):
        calls.append("text")
        return {"action": "click", "elementId": "n0"}

    async def vision_model(messages, **k):
        calls.append("vision")
        assert any(isinstance(p, dict) and p.get("type") == "image_url" for p in messages[-1]["content"])
        return {"action": "done", "message": "Done."}

    monkeypatch.setattr(sa.llm_service, "chat_json", text_model)
    monkeypatch.setattr(sa.llm_service, "vision_json", vision_model)
    run(sa.next_step("like it", "Instagram", ELEMENTS, "", [], 0))
    run(sa.next_step("like it", "Instagram", ELEMENTS, "", [], 0, screenshot=JPEG))
    assert calls == ["text", "vision"]


def test_step_endpoint_reports_a_model_outage_as_503(monkeypatch):
    async def down(*a, **k):
        raise LLMServiceError("provider down")
    monkeypatch.setattr(sa.llm_service, "chat_json", down)
    r = client.post("/ai/screen/step", json={"goal": "scroll down", "elements": ELEMENTS})
    assert r.status_code == 503


def test_step_endpoint_returns_a_validated_action(monkeypatch):
    async def model(*a, **k):
        return {"action": "click", "elementId": "n1"}
    monkeypatch.setattr(sa.llm_service, "chat_json", model)
    r = client.post("/ai/screen/step", json={"goal": "reply yes", "elements": ELEMENTS})
    assert r.status_code == 200 and r.json()["risky"] is True


def result(title, price):
    return ShoppingResult(title=title, price=price, source="Amazon", link="https://x.test/p")


def test_visual_search_finds_the_product_then_prices_it(monkeypatch):
    async def vision(messages, **k):
        return {"summary": "White running shoes", "products": [
            {"name": "Low", "query": "white sneakers", "confidence": 0.3},
            {"name": "Nike Revolution 6", "brand": "Nike", "category": "Shoes", "query": "nike revolution 6 white", "confidence": 0.9},
            {"name": "no query", "query": "  ", "confidence": 1},
        ]}
    asked = []

    async def search(q, max_results=20):
        asked.append(q)
        return [result("Nike Revolution 6", 3299.0)]

    monkeypatch.setattr(sa.llm_service, "vision_json", vision)
    monkeypatch.setattr(sa, "search_products", search)
    out = run(sa.visual_search(JPEG, "find these shoes"))
    assert asked == ["nike revolution 6 white"]
    assert [p["confidence"] for p in out["products"]] == [0.9, 0.3]
    assert out["query"] == "nike revolution 6 white" and out["results"][0]["price"] == 3299.0


def test_visual_search_with_no_product_does_not_search(monkeypatch):
    async def vision(messages, **k):
        return {"summary": "A chat screen", "products": []}

    async def search(*a, **k):
        raise AssertionError("nothing to search for")

    monkeypatch.setattr(sa.llm_service, "vision_json", vision)
    monkeypatch.setattr(sa, "search_products", search)
    out = run(sa.visual_search(JPEG))
    assert out["products"] == [] and out["results"] == [] and out["query"] is None


def test_visual_search_still_answers_when_prices_are_unavailable(monkeypatch):
    async def vision(messages, **k):
        return {"summary": "A lamp", "products": [{"name": "Lamp", "query": "desk lamp", "confidence": 0.8}]}

    async def search(*a, **k):
        raise ShoppingServiceError("no key")

    monkeypatch.setattr(sa.llm_service, "vision_json", vision)
    monkeypatch.setattr(sa, "search_products", search)
    out = run(sa.visual_search(JPEG))
    assert out["query"] == "desk lamp" and out["results"] == [] and "unavailable" in out["note"]


def test_visual_search_rejects_things_that_are_not_images():
    with pytest.raises(sa.ScreenStepError):
        run(sa.visual_search("not an image " * 20))


def test_visual_search_endpoint_validates_size():
    assert client.post("/ai/screen/visual-search", json={"image": "short"}).status_code == 422
