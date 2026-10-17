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
