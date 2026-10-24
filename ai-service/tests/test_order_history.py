"""Past-order questions are answered only from orders read from the store apps / invoices; never guessed."""
from app.shopping import order_history as oh

EVENTS = [
    {"timestamp": "2026-10-20T19:10:00", "action": "order", "name": "Amul Taaza Toned Milk 500 ml", "qty": 2, "price": 56,
     "app": "Blinkit", "orderId": "B1", "source": "store_history"},
    {"timestamp": "2026-10-20T19:10:00", "action": "order", "name": "Britannia Bread", "qty": 1, "price": 45,
     "app": "Blinkit", "orderId": "B1", "source": "store_history"},
    {"timestamp": "2026-10-12T10:00:00", "action": "order", "name": "Paneer Biryani", "qty": 1, "price": None,
     "app": "Zomato", "orderId": "Z9", "source": "invoice"},
    {"timestamp": "2026-10-22T10:00:00", "action": "order", "name": "pizza", "qty": 1, "app": "Zomato",
     "source": "aura_command"},                                  # an AURA cart, not a real order
]


def test_last_order_and_total_come_from_real_orders_only():
    r = oh.answer("what did I order last time?", EVENTS)
    assert "Blinkit on 20 October 2026" in r and "2 × Amul Taaza" in r and "₹101" in r and "pizza" not in r
    assert "came to ₹101" in oh.answer("what was the total of my previous order", EVENTS)


def test_store_filter_including_a_misheard_name():
    assert "Paneer Biryani" in oh.answer("show my recent zomato orders", EVENTS)
    assert "Amul" in oh.answer("show my recent blanket orders", EVENTS)


def test_missing_prices_and_unknown_items_are_said_plainly():
    r = oh.answer("what was the total of my last zomato order", EVENTS)
    assert "can't give you a total" in r
    assert oh.answer("did I order milk before?", EVENTS).startswith("Yes: Amul Taaza Toned Milk")
    assert "don't see eggs" in oh.answer("did I order eggs before?", EVENTS)


def test_nothing_read_yet_and_unrelated_messages():
    assert "haven't read any of your Zepto orders" in oh.answer("show my zepto orders", EVENTS)
    assert "haven't read any" in oh.answer("what did I order last time", [])
    assert oh.answer("order milk from blinkit", EVENTS) is None

def test_tracking_a_live_order_is_not_history():
    assert oh.answer("track my order", EVENTS) is None and oh.answer("where is my zomato order", EVENTS) is None
