"""Customisation sheets: AURA reads every option, asks the user, applies the answer, reads the price back, and only then
presses "Add item". Screens are shaped like the real Zomato sheet seen on the phone; the AI is replaced by a fake."""
import asyncio

import pytest

from app.services import shopping_browser as sb
from app.shopping import food_options as fo

E = sb.PageElement
PRODUCT = "margherita pizza · customisable"


def screen_top(size="Regular", price="₹170", corn=False, paneer=False):
    return [
        E(id="n0", tag="GridView", scrollable=True),
        E(id="n1", tag="ViewGroup", text="Size Required • Select any 1 option"),
        E(id="n2", tag="ViewGroup", text="Regular (serves 1, 17 Cm) ₹170", checked=size == "Regular", checkKind="radio"),
        E(id="n3", tag="ViewGroup", text="Medium (serves 2, 25 Cm) ₹410", checked=size == "Medium", checkKind="radio"),
        E(id="n4", tag="ViewGroup", text="Large (serves 4, 33 Cm) ₹545", checked=size == "Large", checkKind="radio"),
        E(id="n5", tag="ViewGroup", text="Upgrade Your Base - Regular Select up to 1 option"),
        E(id="n6", tag="ViewGroup", text="Ultra Thin Crust Pizza - Regular Pizza ₹20", checked=False, checkKind="radio"),
        E(id="n7", tag="ViewGroup", text="Double Burst ₹79", checked=False, checkKind="radio"),
        E(id="n8", tag="ViewGroup", text="Toppings-Veg (regular)"),
        E(id="n9", tag="ViewGroup", text="Paneer ₹40", checked=paneer, checkKind="check"),
        E(id="n10", tag="ViewGroup", text="Sweet Corns ₹40", checked=corn, checkKind="check"),
        E(id="n11", tag="Button", text=f"Add item {price}"),
    ]


def screen_bottom(paneer=False, price="₹170"):
    return [
        E(id="n0", tag="GridView", scrollable=True),
        E(id="n9", tag="ViewGroup", text="Paneer ₹40", checked=paneer, checkKind="check"),
        E(id="n10", tag="ViewGroup", text="Sweet Corns ₹40", checked=False, checkKind="check"),
        E(id="n12", tag="ViewGroup", text="Mushroom ₹40", checked=False, checkKind="check"),
        E(id="n13", tag="ViewGroup", text="Capsicum ₹40", checked=False, checkKind="check"),
        E(id="n11", tag="Button", text=f"Add item {price}"),
    ]


class Run:
    """Plays the phone: sends screens, records what AURA did (with the user's spoken answers)."""

    def __init__(self):
        self.history = [sb.StepRecord(action="click", target=f"add#0@{PRODUCT}", result="clicked")]

    def step(self, elements, answer=None):
        req = sb.StepRequest(mode="app", phase="cart", store="Zomato", url="Menu", step=len(self.history),
                             items=[sb.CartItem(name="pizza")], history=list(self.history), elements=elements)
        a = asyncio.run(sb.next_step(req))
        result = answer if a.action == "ask" else ("clicked" if a.action == "click" else a.action)
        if a.action not in ("item_done", "done"):
            self.history.append(sb.StepRecord(action=a.action, target=a.targetText, result=result))
        return a


@pytest.fixture
def ai(monkeypatch):
    replies = []

    async def chat_json(messages, **kw):
        if not replies:
            raise sb.LLMServiceError("no AI")
        return replies.pop(0)
    monkeypatch.setattr(sb.llm_service, "chat_json", chat_json)
    sb._plans.clear()
    return replies


def test_reads_groups_rules_prices_and_selection():
    groups = fo.read_sheet(screen_top())
    assert [g.name for g in groups] == ["Size", "Upgrade Your Base - Regular", "Toppings-Veg (regular)"]
    size, base, tops = groups
    assert size.required and size.single and size.max == 1 and [o.checked for o in size.options] == [True, False, False]
    assert size.options[1].name == "Medium (serves 2, 25 Cm)" and size.options[1].price == 410
    assert not base.required and base.max == 1 and not tops.required and not tops.single
    merged, new = fo.merge(groups, fo.read_sheet(screen_bottom(), page=1))
    assert new and [o.name for o in merged[2].options] == ["Paneer", "Sweet Corns", "Mushroom", "Capsicum"]
    assert merged[2].options[2].page == 1
    assert fo.merge(merged, fo.read_sheet(screen_bottom(), page=2))[1] is False      # nothing new: end of the sheet


def test_asks_about_every_option_then_applies_the_answer_and_confirms_the_price(ai):
    run = Run()
    assert run.step(screen_top()).targetText.startswith("scan#0@1@")                 # reads the whole sheet first
    assert run.step(screen_bottom()).targetText.startswith("scan#0@2@")
    q = run.step(screen_bottom())
    assert q.action == "ask" and q.message.endswith("?")
    for words in ("Regular (serves 1, 17 Cm) ₹170", "Medium (serves 2, 25 Cm) ₹410", "Double Burst ₹79",
                  "Mushroom", "₹40 each", "Regular (serves 1, 17 Cm) is selected", "Which size"):
        assert words in q.message
    run.history[-1].result = "medium with paneer"
    ai.append({"cancel": False, "choices": {"Size": ["Medium (serves 2, 25 Cm)"], "Toppings-Veg (regular)": ["Paneer"],
                                            "Upgrade Your Base - Regular": []}})
    # still at the bottom: Paneer is right there
    a = run.step(screen_bottom())
    assert a.action == "click" and a.elementId == "n9" and a.targetText == "pick#0@Paneer"
    # Medium is further up: scroll back to it, then pick it
    a = run.step(screen_bottom(paneer=True, price="₹210"))
    assert a.action == "scroll" and a.text == "up"
    a = run.step(screen_top(price="₹210", paneer=True))
    assert a.action == "click" and a.elementId == "n3" and a.targetText == "pick#0@Medium (serves 2, 25 Cm)"
    # everything set: reads the dish and Zomato's own final price back
    check = run.step(screen_top(size="Medium", price="₹450", paneer=True))
    assert check.action == "ask" and check.targetText.startswith("check#0@")
    assert "Margherita Pizza, Medium (serves 2, 25 Cm), with Paneer" in check.message and "₹450" in check.message
    run.history[-1].result = "yes"
    a = run.step(screen_top(size="Medium", price="₹450", paneer=True))
    assert a.action == "click" and a.elementId == "n11" and a.targetText == f"confirm#0@{PRODUCT}"
    # sheet closed, cart bar shows it: only now is it added
    done = run.step([E(id="c1", tag="TextView", text="1 item added"), E(id="c2", tag="Button", text="View cart")])
    assert done.action == "item_done" and done.itemOk is True


def test_a_change_at_the_price_check_is_applied_and_checked_again(ai):
    run = Run()
    run.history += [sb.StepRecord(action="ask", target=f"ask#0@{fo.dump(fo.read_sheet(screen_top()))}", result="regular, no extras")]
    ai.append({"choices": {"Toppings-Veg (regular)": [], "Upgrade Your Base - Regular": []}})
    check = run.step(screen_top())
    assert check.action == "ask" and "no extras" in check.message
    run.history[-1].result = "add sweet corn please"
    ai.append({"choices": {"Toppings-Veg (regular)": ["Sweet Corns"]}})
    a = run.step(screen_top())
    assert a.targetText == "pick#0@Sweet Corns"
    again = run.step(screen_top(price="₹210", corn=True))
    assert again.action == "ask" and "with Sweet Corns" in again.message


def test_cancel_closes_the_sheet_and_nothing_is_added(ai):
    run = Run()
    run.history += [sb.StepRecord(action="ask", target=f"ask#0@{fo.dump(fo.read_sheet(screen_top()))}", result="cancel it")]
    a = run.step(screen_top())
    assert a.action == "back" and a.targetText == "cancel#0@"
    done = run.step([E(id="m1", tag="Button", text="ADD", context="Margherita Pizza ₹170")])
    assert done.action == "item_done" and done.itemOk is False and "you said not to" in done.reason


def test_no_answer_asks_once_more_then_lets_the_user_pick_on_screen(ai):
    run = Run()
    run.history += [sb.StepRecord(action="ask", target=f"ask#0@{fo.dump(fo.read_sheet(screen_top()))}", result="(no answer)")]
    again = run.step(screen_top(), answer="(no answer)")
    assert again.action == "ask" and again.message.startswith("Sorry, I didn't catch that")
    manual = run.step(screen_top())
    assert manual.action == "need_user" and "tap Continue" in manual.message
    # the user picked and tapped Continue: AURA presses Add item
    a = run.step(screen_top(size="Large", price="₹545"))
    assert a.action == "click" and a.elementId == "n11"


def test_without_the_ai_option_names_in_the_answer_still_work(ai):
    groups = fo.read_sheet(screen_top())
    plan = fo.rule_plan("large one with paneer and sweet corns", groups)
    assert plan["Size"] == ["Large (serves 4, 33 Cm)"] and plan["Toppings-Veg (regular)"] == ["Paneer", "Sweet Corns"]
    assert fo.rule_plan("medium, no toppings", groups)["Toppings-Veg (regular)"] == []


def test_sheet_with_nothing_to_choose_still_confirms_dish_and_price(ai):
    run = Run()
    sheet = [E(id="n1", tag="ViewGroup", text="Crust Required • 1 option available"),
             E(id="n2", tag="ViewGroup", text="2in1 Cheese Burst", checked=True, checkKind="radio"),
             E(id="n9", tag="Button", text="Add item ₹299 ₹229")]
    q = run.step(sheet)
    assert q.action == "ask" and "₹229" in q.message and q.message.endswith("Shall I add it to the cart?")
    run.history[-1].result = "yes"
    assert run.step(sheet).elementId == "n9"


def test_a_container_around_a_whole_group_is_not_an_option():
    """Seen on the phone (Domino's on Zomato): one clickable row wrapped the headers and options, and its text
    became a bogus option "Crust Required • 1 option available Cheese Burst ..."."""
    sheet = [E(id="n1", tag="ViewGroup", text="Crust Required • 1 option available Cheese Burst Size Required • 1 option "
                                                "available Large Plus ₹2149", checked=True, checkKind="radio"),
             E(id="n2", tag="ViewGroup", text="Crust Required • 1 option available"),
             E(id="n3", tag="ViewGroup", text="Cheese Burst", checked=True, checkKind="radio"),
             E(id="n4", tag="ViewGroup", text="Size Required • 1 option available"),
             E(id="n5", tag="ViewGroup", text="Large Plus ₹2149", checked=True, checkKind="radio"),
             E(id="n9", tag="Button", text="Add item ₹2149 ₹999")]
    groups = fo.read_sheet(sheet)
    assert [(g.name, [o.name for o in g.options]) for g in groups] == [("Crust", ["Cheese Burst"]), ("Size", ["Large Plus"])]
    assert fo.question("Big Big 6in1 Cheeseburst - Veg", groups) is None      # nothing to choose: only the price check


def test_ai_cannot_add_an_unrelated_suggestion_or_confirm_a_sheet_itself(monkeypatch):
    """Seen on the phone: asked for a veg burger, the AI added a "BK Veg Pizza Puff" from the "pairs well with" row,
    and pressed a combo sheet's "Add item ₹139" without asking."""
    item = sb.CartItem(name="Korean Crispy Veg Burger Combo")
    replies = []

    async def chat_json(*a, **k):
        return replies.pop(0)
    monkeypatch.setattr(sb.llm_service, "chat_json", chat_json)
    monkeypatch.setattr(sb, "fast_step", lambda r: None)
    req = sb.StepRequest(mode="app", phase="cart", store="Zomato", url="Menu", step=5, items=[item],
                         elements=[E(id="n1", tag="Button", text="ADD", context="BK Veg Pizza Puff. ₹59"),
                                   E(id="n2", tag="Button", text="Add item ₹234 ₹139")])
    replies.append({"action": "click", "elementId": "n1", "reason": "add it"})
    a = asyncio.run(sb.next_step(req))
    assert a.action != "click"                                   # refused: not tapped (recovers by searching or scrolling)
    replies.append({"action": "click", "elementId": "n2", "reason": "add item"})
    a = asyncio.run(sb.next_step(req))
    assert a.action == "wait" and a.targetText.startswith("add#0@") and "asking you" in a.reason
    # from there the sheet flow takes over: it asks first
    req.history = [sb.StepRecord(action="wait", target=a.targetText, result="waited")]
    a = asyncio.run(sb.next_step(req))
    assert a.action == "ask" and "₹139" in a.message


def test_dish_name_read_aloud_without_separators():
    assert sb._dish("· bk veg pizza puff.") == "Bk Veg Pizza Puff"


def test_an_add_button_with_an_icon_or_price_is_still_checked(monkeypatch):
    """Seen on the phone: asked for masala dosa, the AI tapped "ADD ₹" on a burger wrap; untagged, nothing checked it."""
    replies = []

    async def chat_json(*a, **k):
        return replies.pop(0)
    monkeypatch.setattr(sb.llm_service, "chat_json", chat_json)
    monkeypatch.setattr(sb, "fast_step", lambda r: None)
    req = sb.StepRequest(mode="app", phase="cart", store="Zomato", url="Search", step=2, items=[sb.CartItem(name="masala dosa")],
                         elements=[E(id="n26", tag="Button", text="ADD ", context="Chipotle Veg Fingers Burger Wrap ₹129"),
                                   E(id="n27", tag="Button", text="ADD ₹", context="Mysore Masala Dosa ₹110")])
    replies.append({"action": "click", "elementId": "n26", "reason": "add it"})
    a = asyncio.run(sb.next_step(req))
    assert a.action != "click" or a.elementId != "n26"           # the burger wrap is not tapped
    replies.append({"action": "click", "elementId": "n27", "reason": "add the dosa"})
    a = asyncio.run(sb.next_step(req))
    assert a.action == "click" and a.targetText.startswith("add#0@") and "dosa" in a.targetText


def test_addition_is_recognised_when_the_recorded_name_has_a_stray_symbol():
    """Seen on the phone: Zomato showed "1 item added" and a stepper on Paneer Biryani, but the ADD had been recorded as
    "paneer biryani ·", which matched nothing, so AURA said "0/1 added"."""
    product = "paneer biryani ·"
    screen = [E(id="n13", tag="ViewGroup", text="1 item added Continue"),
              E(id="n27", tag="ImageView", text="Paneer Biryani", label="Paneer Biryani",
                context="Paneer Biryani Highly reordered ₹220   Paneer Biryani  1 "),
              E(id="n30", tag="View", text="1", label="1", context="Paneer Biryani  1 "),
              E(id="n35", tag="View", text="ADD", label="ADD", context="Paneer Roll ₹65 ₹130 50% OFF Try New Deal ADD")]
    req = sb.StepRequest(mode="app", phase="cart", store="Zomato", url="Menu", step=10, items=[sb.CartItem(name="paneer biryani")],
                         history=[sb.StepRecord(action="click", target=f"add#0@{product}", result="clicked")], elements=screen)
    assert sb._added_proof(req, product)
    a = sb.fast_step(req)
    assert a.action == "item_done" and a.itemOk is True


def test_dish_name_drops_app_icon_glyphs():
    """Seen on the phone: "Pick the options for Veg Fried Rice  in Zomato"."""
    assert sb._dish("veg fried rice  customisable") == "Veg Fried Rice"
    assert sb._dish("paneer tikka (8 pcs) · customisable") == "Paneer Tikka (8 Pcs)"


def test_wishlist_is_not_an_add_and_a_refused_tap_recovers(monkeypatch):
    """Seen ordering milk on Blinkit: "Add to wishlist" was treated as ADD, refused 15 times, and the run ended."""
    assert not sb._is_add(E(id="w", tag="View", text="Add to wishlist image of 85 g options"))
    replies = []

    async def chat_json(*a, **k):
        return replies.pop(0)
    monkeypatch.setattr(sb.llm_service, "chat_json", chat_json)
    monkeypatch.setattr(sb, "fast_step", lambda r: None)
    req = sb.StepRequest(mode="app", phase="cart", store="Blinkit", url="Search", step=4, items=[sb.CartItem(name="milk")],
                         elements=[E(id="n1", tag="EditText", text="milk", editable=True),
                                   E(id="n2", tag="View", text="ADD", context="Lays Chips 52 g ₹20"),
                                   E(id="n3", tag="ScrollView", scrollable=True)])
    replies.append({"action": "click", "elementId": "n2", "reason": "add"})
    a = asyncio.run(sb.next_step(req))
    assert a.action == "scroll" and "milk" in a.reason          # moves on, doesn't wait forever


def test_reading_past_orders_never_taps_into_another_store(monkeypatch):
    """Seen ordering milk on Blinkit: the "zomato" promo button was tapped while looking for the orders page."""
    from app.services import shopping_history_reader as hr

    async def chat_json(*a, **k):
        return {"action": "click", "elementId": "n9", "reason": "account"}
    monkeypatch.setattr(sb.llm_service, "chat_json", chat_json)

    async def finish(req, reason, saved=0):
        return sb.StepAction(action="history_done", reason=reason, source="fast")
    monkeypatch.setattr(hr, "_finish_history", finish)
    req = sb.StepRequest(mode="app", phase="history", store="Blinkit", url="Home", step=1, items=[sb.CartItem(name="milk")],
                         elements=[E(id="n9", tag="View", text="zomato", label="unlabeled icon at bottom-right")])
    a = asyncio.run(hr.history_step(req))
    assert a.action == "history_done"


def test_blinkit_pack_sheet_after_add_picks_pack_of_one():
    """Seen ordering milk on Blinkit: ADD opened "Pack of 1 / Pack of 2" and those ADDs were refused as not-milk."""
    product = "pride of cows farm cow milk 500 ml"
    req = sb.StepRequest(mode="app", phase="cart", store="Blinkit", url="Search", step=8, items=[sb.CartItem(name="milk")],
                         history=[sb.StepRecord(action="click", target=f"add#0@{product}", result="clicked")],
                         elements=[E(id="a", tag="View", text="ADD", context="Pack of 1 500 ml ₹85 ₹85/bottle"),
                                   E(id="b", tag="View", text="ADD", context="Pack of 2 500 ml ₹169 ₹84.5/bottle")])
    a = sb.fast_step(req)
    assert a.action == "click" and a.elementId == "a"


def test_sponsored_listing_loses_a_tie():
    req = sb.StepRequest(mode="app", phase="cart", store="Blinkit", url="Search", step=3, items=[sb.CartItem(name="milk")],
                         elements=[E(id="ad", tag="View", text="ADD", context="Ad Pride of Cows Farm Cow Milk 500 ml ₹85"),
                                   E(id="n", tag="View", text="ADD", context="Nandini Toned Milk 500 ml ₹24")])
    assert sb._best_add(req, req.items[0]).id == "n"


def test_pack_is_tapped_only_once():
    req = sb.StepRequest(mode="app", phase="cart", store="Blinkit", url="Search", step=9, items=[sb.CartItem(name="milk")],
                         history=[sb.StepRecord(action="click", target="add#0@pride of cows milk", result="clicked"),
                                  sb.StepRecord(action="click", target="add#0@pack of 1 500 ml 85", result="clicked")],
                         elements=[E(id="a", tag="View", text="ADD", context="Pack of 1 500 ml ₹85")])
    a = sb.fast_step(req)
    assert not (a and a.action == "click" and a.elementId == "a")
