"""The "cart agent": drives a real store, one step at a time, to put items in the user's cart.

Two modes, same decision loop:
  * app - the phone's AuraAccessibilityService opens the store's installed Android app (Blinkit, Zepto,
    Swiggy...) and sends the views on screen (text, content descriptions, editable/clickable flags);
  * web - the phone hosts the store's website in a WebView and sends the visible buttons/links/inputs.
Either way the user is logged in themselves (AURA never sees credentials). After every screen change the
device sends a compact snapshot (each control with the product text around it) to
POST /ai/shopping/browse/step; this module asks the LLM for the single next action (navigate / click /
type / scroll / back / mark item done / ask the user / finish) and returns it. Works on any store: known
stores get shortcuts (search URL, Android package), unknown ones are found by the agent / on the device.

Hard boundary: the agent fills the cart and stops. It never clicks pay/checkout/place-order controls,
never types into payment, OTP, PIN or password fields, and never navigates to payment URLs. This is
enforced here (server) and again on the device (safety.js + the WebView's URL filter).
"""
from __future__ import annotations

import re
import time
from urllib.parse import quote, quote_plus, urlparse

import structlog
from typing import Literal

from pydantic import BaseModel, Field

from app.core.config import settings
from app.ml.shopping_catalog import CATALOG, FOOD_APPS, canonical_app, canonical_item, dish_item
from app.services.llm_service import LLMServiceError, llm_service

logger = structlog.get_logger()

# name, website home + search template ({q} = url-encoded query), Android package when well known.
# The phone also finds installed apps by name (appLabel / store name), so stores without a package work too.
STORES: dict[str, dict] = {
    "blinkit": {"name": "Blinkit", "home": "https://blinkit.com/", "search": "https://blinkit.com/s/?q={q}",
                "package": "com.grofers.customerapp", "appLabel": "Blinkit"},
    "zepto": {"name": "Zepto", "home": "https://www.zeptonow.com/", "search": "https://www.zeptonow.com/search?query={q}",
              "package": "com.zeptoconsumerapp", "appLabel": "Zepto"},
    "instamart": {"name": "Swiggy Instamart", "home": "https://www.swiggy.com/instamart",
                  "search": "https://www.swiggy.com/instamart/search?custom_back=true&query={q}",
                  "package": "in.swiggy.android", "appLabel": "Swiggy",
                  "appHint": "Instamart is a section inside the Swiggy app: open the Instamart tab/tile first.",
                  "historyHint": "Instamart orders are listed in the Swiggy app under Account > Orders (Instamart tab)."},
    "bigbasket": {"name": "BigBasket", "home": "https://www.bigbasket.com/", "search": "https://www.bigbasket.com/ps/?q={q}",
                  "package": "com.bigbasket.mobileapp", "appLabel": "bigbasket"},
    "jiomart": {"name": "JioMart", "home": "https://www.jiomart.com/", "search": "https://www.jiomart.com/search/{q}",
                "package": "com.jpl.jiomart", "appLabel": "JioMart"},
    "amazon": {"name": "Amazon", "home": "https://www.amazon.in/", "search": "https://www.amazon.in/s?k={q}",
               "package": "in.amazon.mShop.android.shopping", "appLabel": "Amazon"},
    "flipkart": {"name": "Flipkart", "home": "https://www.flipkart.com/", "search": "https://www.flipkart.com/search?q={q}",
                 "package": "com.flipkart.android", "appLabel": "Flipkart"},
    "myntra": {"name": "Myntra", "home": "https://www.myntra.com/", "search": "https://www.myntra.com/{slug}",
               "package": "com.myntra.android", "appLabel": "Myntra"},
    "ajio": {"name": "AJIO", "home": "https://www.ajio.com/", "search": "https://www.ajio.com/search/?text={q}",
             "package": "com.ril.ajio", "appLabel": "AJIO"},
    "nykaa": {"name": "Nykaa", "home": "https://www.nykaa.com/", "search": "https://www.nykaa.com/search/result/?q={q}",
              "package": "com.fsn.nykaa", "appLabel": "Nykaa"},
    "meesho": {"name": "Meesho", "home": "https://www.meesho.com/", "search": "https://www.meesho.com/search?q={q}",
               "package": "com.meesho.supply", "appLabel": "Meesho"},
    "1mg": {"name": "Tata 1mg", "home": "https://www.1mg.com/", "search": "https://www.1mg.com/search/all?name={q}",
            "package": "com.aranoah.healthkart.plus", "appLabel": "Tata 1mg"},
    "pharmeasy": {"name": "PharmEasy", "home": "https://pharmeasy.in/", "search": "https://pharmeasy.in/search/all?name={q}"},
    "croma": {"name": "Croma", "home": "https://www.croma.com/", "search": "https://www.croma.com/searchB?q={q}"},
    "zomato": {"name": "Zomato", "home": "https://www.zomato.com/", "search": "https://www.zomato.com/search?q={q}",
               "package": "com.application.zomato", "appLabel": "Zomato",
               "appHint": "Food delivery: search the dish, open the right restaurant (see the item's hint) if the result "
                          "is a restaurant, then ADD the dish there. If a customisation sheet opens, keep the defaults "
                          "and confirm with its Add item button.",
               "historyHint": "Orders are under the profile icon > Your orders."},
    "dmart": {"name": "DMart Ready", "home": "https://www.dmart.in/", "search": "https://www.dmart.in/search?searchTerm={q}"},
}
_ALIASES = {"swiggy instamart": "instamart", "swiggy": "instamart", "big basket": "bigbasket", "jio mart": "jiomart",
            "amazon fresh": "amazon", "amazon.in": "amazon", "tata 1mg": "1mg", "dmart ready": "dmart",
            "flipkart minutes": "flipkart", "grofers": "blinkit"}

FORBIDDEN = re.compile(
    r"\b(pay|payment|payments|checkout|check out|place[\s-]?order|confirm[\s-]?order|complete[\s-]?order|"
    r"buy[\s-]?now|proceed\s+to\s+(pay|buy|checkout)|upi|card\s+number|cvv|otp|net\s?banking|wallet\s+pay|"
    r"cash\s+on\s+delivery|slide\s+to\s+pay|swipe\s+to\s+pay)\b", re.I)
FORBIDDEN_URL = re.compile(r"(pay|checkout|place.?order|confirm.?order|payment|upi|/buy/)", re.I)
SENSITIVE_INPUT = re.compile(r"(password|passcode|otp|one.?time|pin\b|cvv|card|upi|vpa|account.?number)", re.I)
MAX_STEPS_PER_ITEM = 14
MAX_STEPS_BASE = 12


def store_key(name: str | None) -> str | None:
    if not name:
        return None
    key = re.sub(r"\s+", " ", name.strip().lower())
    key = _ALIASES.get(key, key)
    if key in STORES:
        return key
    canon = canonical_app(name).lower()
    return next((k for k, v in STORES.items() if v["name"].lower() == canon), None)


def search_url(key: str | None, query: str) -> str | None:
    store = STORES.get(key or "")
    if not store:
        return None
    return store["search"].format(q=quote_plus(query), slug=quote(re.sub(r"\s+", "-", query.strip().lower())))


def resolve_store(name: str | None) -> dict:
    """Known store -> its site; anything else -> start from a web search for the store's own site."""
    key = store_key(name)
    if key:
        st = STORES[key]
        return {"key": key, "name": st["name"], "startUrl": st["home"], "known": True,
                "androidPackage": st.get("package"), "appLabel": st.get("appLabel") or st["name"]}
    label = (name or "online store").strip()
    return {"key": None, "name": label, "known": False, "androidPackage": None, "appLabel": label,
            "startUrl": f"https://www.google.com/search?q={quote_plus(label + ' official online shopping site')}"}


# ---------------------------------------------------------------------- step protocol
class PageElement(BaseModel):
    id: str
    tag: str = ""  # web: html tag; app: view class (Button, EditText, TextView, ImageView...)
    editable: bool = False
    scrollable: bool = False
    role: str | None = None
    text: str = ""
    label: str | None = None
    href: str | None = None
    type: str | None = None
    value: str | None = None
    context: str | None = Field(None, description="text of the product card / section around the element")
    disabled: bool = False


class CartItem(BaseModel):
    name: str
    qty: int = 1
    status: str = "pending"  # pending | added | failed
    note: str | None = None
    hint: str | None = None  # extra targeting from the user's history, e.g. "from restaurant Biryani Zest"


class StepRecord(BaseModel):
    action: str
    target: str | None = None
    result: str | None = None
    url: str | None = None


class StepRequest(BaseModel):
    mode: Literal["web", "app"] = "web"
    appPackage: str | None = None
    # history: first read the user's past orders in the store app; cart: add the items
    phase: Literal["history", "cart"] = "cart"
    # false until the items were matched to the user's usual products (the first cart step does it)
    resolved: bool = True
    ordersRead: int = 0
    # orders seen on screen that were already in the history (a re-sync stops once it reaches them)
    ordersKnown: int = 0
    # how many past orders to read: a quick look before ordering, more for a full "learn from my orders" sync
    historyLimit: int = Field(8, ge=1, le=40)
    userId: str | None = None  # set by the backend from the verified session, never by the device
    store: str
    items: list[CartItem] = Field(default_factory=list)
    url: str
    title: str = ""
    elements: list[PageElement] = Field(default_factory=list)
    pageText: str = ""
    history: list[StepRecord] = Field(default_factory=list)
    step: int = 0


class StepAction(BaseModel):
    # navigate | click | type | scroll | wait | back | item_done | need_user | done
    # | history_done (switch to the cart phase) | set_items (replace the item list, see `items`)
    action: str
    items: list[dict] | None = None
    ordersSaved: int = 0
    ordersKnown: int = 0
    elementId: str | None = None
    text: str | None = None
    submit: bool = False
    url: str | None = None
    repeat: int = 1
    itemIndex: int | None = None
    itemOk: bool | None = None
    completesItem: bool = False  # legacy hint; items are only marked added after the server verifies them
    # what was clicked, as the device should record it in history ("add@<product>" for ADD buttons), so the next
    # step can verify the item really went into the cart
    targetText: str | None = None
    message: str | None = None
    reason: str = ""
    source: str = "llm"  # llm | fast (decided from the screen, no LLM) | heuristic (LLM unavailable) | guard


_STEP_PROMPT = """You operate a shopping website inside the user's phone to put items into their cart on {store}.
The user is logged in already (their own session). You see a snapshot of the current page: interactive elements
with ids, their text, and "context" = the product card/section text around them.

Items (index: name x qty [status]):
{items}
Current item: {current}

Return JSON only, one next action:
{{"action": "navigate"|"click"|"type"|"scroll"|"back"|"wait"|"item_done"|"need_user"|"done",
  "elementId": id for click/type or null, "text": text to type or null, "submit": true to press Enter after typing,
  "url": for navigate, "repeat": clicks (only for a quantity "+" button), "itemIndex": item the action is about,
  "itemOk": for item_done, "message": for need_user (what the user must do) or done, "reason": short why}}

How to work:
- Find the current item: use the site's search box (type + submit) or navigate to a search URL{search_hint}.
- Pick the result whose context best matches the item (brand/size if given; otherwise a common, well-rated,
  in-stock, reasonably priced option). Click its "ADD"/"Add to cart" control. For qty > 1 click the "+" next to it
  (repeat = qty-1) after it was added. If a size/variant picker pops up, pick the closest match and confirm adding.
- After the item is in the cart (the ADD turned into a quantity stepper, or "added to cart" shown), the item is done.
  If it is out of stock or not sold here after one or two searches, use item_done with itemOk=false and move on.
- Close popups/banners that block the page. If the site needs login, OTP, a delivery location/address, or a captcha,
  use need_user with a clear message; never type into login/OTP/password/payment fields yourself.
- When every item is added or failed: open the cart (cart icon / "View cart") so the user can see it, then done.
- NEVER click or navigate to anything that pays or orders: Pay, Checkout, Proceed to pay, Place order, Buy now,
  Confirm order, UPI, card or wallet payment, Cash on delivery. Stopping at the cart is the goal.
- Don't repeat an action that didn't change anything (see history); try something else.
If unknown store: if this is a search engine page, open the store's official website result (not ads or other
stores), then search there."""


_APP_PROMPT = """You operate the {store} Android app on the user's phone to put items into their cart. The user is
logged in already (their own app). You see the views on the current screen with ids: their text or content
description, class (EditText = text box), flags, and "context" = the product card/section text around them.
{app_hint}
Items (index: name x qty [status]):
{items}
Current item: {current}

Return JSON only, one next action:
{{"action": "click"|"type"|"scroll"|"back"|"wait"|"item_done"|"need_user"|"done",
  "elementId": id for click/type or null, "text": text to type or null, "submit": true to press the keyboard's
  search/enter key after typing, "repeat": clicks (only for a quantity "+" button), "itemIndex": item the action is
  about, "itemOk": for item_done,
  "message": for need_user (what the user must do) or done, "reason": short why}}

How to work:
- There are no URLs here. To find an item: click the search bar/icon, then type the item into the EditText with
  submit=true. If you are on a search screen for a different item, type the new item into the same box.
  "back" presses the phone's back button (closes sheets, leaves product pages).
- Pick the result whose context best matches the item (brand/size if given; otherwise a common, well-rated, in-stock,
  reasonably priced option). Click its "ADD"/"Add to cart" control. For qty > 1 click the "+" next to it
  (repeat = qty-1) after it was added. If a variant/size sheet or popup opens (it is listed first, on top), pick the
  size closest to the item (else the most common one) and press its ADD/confirm there; don't tap the card's ADD again.
- After the item is in the cart (ADD turned into a quantity stepper, or "added" shown), the item is done.
  If it is out of stock or not sold here after one or two searches, use item_done with itemOk=false and move on.
- Close popups/offers that block the screen (close/X/"not now"/"skip", or back). If the app needs login, OTP, a
  delivery location/address, an update, or permissions, use need_user with a clear message; never type into
  login/OTP/password/payment fields yourself.
- If nothing useful is visible, scroll, or wait once for loading.
- When every item is added or failed: open the cart (cart icon / "View cart") so the user can see it, then done.
- NEVER click anything that pays or orders: Pay, Checkout, Proceed to pay, Place order, Buy now, Slide to pay,
  Confirm order, UPI, card or wallet payment, Cash on delivery. Stopping at the cart is the goal.
- Don't repeat an action that didn't change anything (see history); try something else."""


def _items_text(items: list[CartItem]) -> str:
    return "\n".join(f"{i}: {it.name} x{it.qty} [{it.status}]{' - ' + it.hint if it.hint else ''}"
                     for i, it in enumerate(items))


def _current(items: list[CartItem]) -> int | None:
    return next((i for i, it in enumerate(items) if it.status == "pending"), None)


def _page_text(req: StepRequest, limit: int = 140) -> str:
    lines = []
    for el in req.elements[:limit]:
        bits = [f"[{el.id}] <{el.tag}{' ' + el.type if el.type else ''}>"]
        if el.text:
            bits.append(repr(el.text[:80]))
        if el.label and el.label != el.text:
            bits.append(f"label={el.label[:60]!r}")
        if el.href:
            bits.append(f"href={el.href[:80]}")
        if el.value:
            bits.append(f"value={el.value[:40]!r}")
        if el.context and el.context != el.text:
            bits.append(f"context={el.context[:140]!r}")
        if el.editable:
            bits.append("editable")
        if el.scrollable:
            bits.append("scrollable")
        if el.disabled:
            bits.append("disabled")
        lines.append(" ".join(bits))
    hist = "\n".join(f"- {h.action} {h.target or ''} -> {h.result or ''} ({h.url or ''})" for h in req.history[-10:])
    where = f"App: {req.appPackage}, screen {req.url}" if req.mode == "app" else f"URL: {req.url}"
    return (f"{where}\nTitle: {req.title}\nStep {req.step}\n\nRecent actions:\n{hist or '- none yet'}\n\n"
            f"Visible text (start):\n{req.pageText[:1200]}\n\nElements:\n" + "\n".join(lines))


def _element(req: StepRequest, eid: str | None) -> PageElement | None:
    return next((e for e in req.elements if e.id == eid), None) if eid else None


def guard(action: StepAction, req: StepRequest) -> StepAction:
    """Rewrites anything that would pay, order, or touch credentials into a stop."""
    el = _element(req, action.elementId)
    if action.action in ("click", "type") and el is None:
        return StepAction(action="wait", reason=f"element {action.elementId} not on page", source="guard")
    if action.action == "click" and el is not None:
        blob = " ".join(filter(None, [el.text, el.label, el.href]))
        if FORBIDDEN.search(blob) or (el.href and FORBIDDEN_URL.search(el.href)):
            return StepAction(action="done", message="Items are in the cart. Stopped before checkout/payment, "
                              "which AURA does not do yet.", reason=f"blocked payment-like click: {blob[:60]}",
                              source="guard")
    if action.action == "type" and el is not None:
        blob = " ".join(filter(None, [el.label, el.type, el.text, el.tag]))
        if SENSITIVE_INPUT.search(blob) or (el.type or "").lower() == "password":
            return StepAction(action="need_user", message="This page wants a login/OTP/payment detail. "
                              "Please enter it yourself, then tap Continue.", reason="sensitive input", source="guard")
    if action.action == "navigate" and req.mode == "app":
        return StepAction(action="wait", reason="no URLs inside an app; use its search bar", source="guard")
    if action.action == "navigate":
        url = action.url or ""
        if urlparse(url).scheme != "https" or FORBIDDEN_URL.search(urlparse(url).path + "?" + urlparse(url).query):
            return StepAction(action="wait", reason=f"refused navigation to {url[:80]}", source="guard")
    action.repeat = max(1, min(action.repeat or 1, 20))
    return action


# ---------------------------------------------------------------------- fast path (no LLM)
_UNIT = re.compile(r"^(\d+(\.\d+)?|g|gm|gms|kg|ml|l|ltr|litre|pc|pcs|pack|packs|x|of|the|and|a)$")
_ADD = re.compile(r"^(add|add to cart|add to basket|add to bag|add item)$", re.I)
_PLUS = re.compile(r"^(\+|increase|increment|add one more|plus)\b", re.I)


def _words(name: str) -> list[str]:
    ws = [w for w in re.findall(r"[a-z0-9]+", name.lower()) if len(w) > 1 and not _UNIT.match(w)]
    return ws or [name.lower().strip()]


_NOISE = re.compile(
    r"₹\s*[\d,]+(\.\d+)?|\brs\.?\s*[\d,]+|\b\d+(\.\d+)?\s*%\s*off\b|\b\d(\.\d)?\s*\(\s*[\d.]+\s*k?\s*\)|"
    r"\(\s*[\d.]+\s*k?\s*\)|\b(add|add to cart|add to basket|notify me|out of stock|sold out|off|mins?|ad)\b|[−+–|·,]",
    re.I)


def _product(el: PageElement) -> str:
    """Product name from a card's text, with prices, discounts, ratings, ADD and steppers removed, lower-cased.
    Cards differ by store ("₹54 ₹80 Country Delight Dahi Cup 400 g ADD" vs "Nandini Curd Pouch, 1 pack, 4.8 (18k)")."""
    text = (el.context or el.text or "").lower()
    text = _NOISE.sub(" ", text)
    text = re.sub(r"\b\d+(\.\d+)?\b(?!\s*(g|gm|kg|ml|l|ltr|pc|pcs|pack|x)\b)", " ", text)  # stray numbers
    return re.sub(r"\s+", " ", text).strip()[:80]


def _same_item(product: str, item: CartItem, food: bool = False) -> int:
    """How well a product matches the item: 2 = confidently the same thing, 1 = contains its words, 0 = no.
    Catalog synonyms count (dahi = curd, doodh = milk, maggi = instant noodles). On food-delivery apps the grocery
    catalog doesn't apply ("aloo paratha" is a dish, not potatoes): the dish's words must all be in the name."""
    if food:
        want, got = dish_item(item.name).split(), dish_item(product)
        return 2 if want and got and all(w in got for w in want) else 0
    words = _words(item.name)
    want = canonical_item(item.name)
    if not product:
        return 0
    got = canonical_item(product)
    if want in CATALOG and got == want:
        return 2
    if want in CATALOG and got in CATALOG:
        return 0  # a different known thing that merely mentions the word ("Milk Bikis" biscuits for "milk")
    if not all(w in product for w in words):
        return 0
    name_words = _words(product)
    if len(words) > 1 or (name_words and (name_words[-1] == words[-1] or words[-1] in name_words[-3:])):
        return 2
    return 1


def _is_add(el: PageElement) -> bool:
    return bool(_ADD.match((el.text or "").strip()) or _ADD.match((el.label or "").strip()))


def _best_add(req: StepRequest, item: CartItem) -> PageElement | None:
    """The ADD of the result that best matches the item. Grocery names end with the noun ("Amul Taaza Toned
    Milk 500 ml"), so a product whose last word is the item's last word beats one that merely contains it
    ("Milk Bikis Biscuits"). Ties keep the store's own ranking (first listed)."""
    best, best_score = None, 0
    food = canonical_app(req.store) in FOOD_APPS
    restaurant = (item.hint or "").lower().replace("from restaurant", "").strip()
    for el in req.elements:
        if not _is_add(el) or el.disabled:
            continue
        score = _same_item(_product(el), item, food)
        if score and food and restaurant:
            # the same dish name exists at many restaurants: only the user's restaurant is a confident match
            score = 3 if restaurant in f"{el.context or ''} {req.pageText}".lower() else 1
        if score > best_score:
            best, best_score = el, score
    # a single generic word that only appears mid-name ("milk" in "Milk Bikis") is the LLM's call
    return best if best_score >= 2 else None


def _plus_for(req: StepRequest, product: str) -> PageElement | None:
    return next((e for e in req.elements if (_PLUS.match((e.text or "").strip()) or _PLUS.match((e.label or "").strip()))
                 and product and _product(e).startswith(product[:25])), None)


def _tap(kind: str, idx: int, product: str) -> str:
    """History target for a tap, tied to the item it was for: add#1@country delight dahi cup 400 g."""
    return f"{kind}#{idx}@{product}"


def _parse_tap(target: str | None) -> tuple[str, int, str] | None:
    m = re.match(r"^(add|plus)#(\d+)@(.*)$", target or "")
    return (m.group(1), int(m.group(2)), m.group(3)) if m else None


def _visible(req: StepRequest, product: str) -> bool:
    key = product[:25]
    return bool(key) and any(_product(e).startswith(key) for e in req.elements)


def _add_gone(req: StepRequest, product: str) -> bool:
    """On this screen, the product is shown but its ADD button isn't: a quantity stepper replaced it.
    False when the product isn't on screen at all (another page, a popup on top): we can't tell from here."""
    key = product[:25]
    return _visible(req, product) and not any(_is_add(e) and _product(e).startswith(key) for e in req.elements)


def _failed_adds(req: StepRequest, idx: int, product: str) -> int:
    return sum(1 for h in req.history if (t := _parse_tap(h.target)) and t[0] == "add" and t[1] == idx
               and t[2][:25] == product[:25] and (h.result or "").startswith("clicked"))


def _added_ok(req: StepRequest, idx: int) -> bool:
    """The item's last ADD tap worked, judged on the current screen."""
    for h in reversed(req.history):
        tap = _parse_tap(h.target)
        if tap and tap[1] == idx and tap[0] == "add" and (h.result or "").startswith("clicked"):
            return bool(tap[2]) and _add_gone(req, tap[2])
    return False


MAX_ADD_TAPS = 3  # taps on the same product's ADD without it turning into a stepper, then give up on the item


def _last(req: StepRequest, action: str | None = None):
    for h in reversed(req.history):
        if action is None or h.action == action:
            return h
    return None


def _cart_summary(req: StepRequest) -> str:
    """What the cart screen actually shows, item by item (the user sees this as the final message)."""
    names = [_product(e) for e in req.elements] + [_product(PageElement(id="t", context=req.pageText))]
    seen = [it.name for it in req.items if any(_same_item(n, it) for n in names if n)]
    missing = [it.name for it in req.items if it.name not in seen]
    if not missing:
        return "In your cart: " + ", ".join(seen) + "."
    return (f"In your cart: {', '.join(seen) or 'none of them'}. Not added: {', '.join(missing)} "
            "(add these yourself, or ask again).")


def fast_step(req: StepRequest) -> StepAction | None:
    """Obvious steps decided straight from the screen, no LLM: verify the last ADD, tap "+" for quantity,
    tap the matching ADD, open search / type the item, open the cart at the end. None = ask the LLM."""
    idx = _current(req.items)
    if idx is None:
        cart = next((e for e in req.elements if re.search(r"\b(view cart|go to cart|cart|basket|bag)\b",
                                                         f"{e.text} {e.label or ''}", re.I)
                     and not FORBIDDEN.search(f"{e.text} {e.label or ''}")), None)
        opened = any(h.action == "click" and (h.target or "").startswith("cart") for h in req.history[-3:])
        if cart and not opened:
            return StepAction(action="click", elementId=cart.id, targetText="cart", reason="open the cart", source="fast")
        return StepAction(action="done", message=_cart_summary(req), source="fast")

    item = req.items[idx]
    last = _last(req)
    # 1. verify this item's last tap: its ADD button is gone (a quantity stepper took its place)
    tap = _parse_tap(last.target) if last and last.action == "click" and (last.result or "").startswith("clicked") else None
    if tap and tap[1] == idx and tap[0] == "add":
        product = tap[2]
        if product and _add_gone(req, product):
            if item.qty > 1:
                plus = _plus_for(req, product)
                if plus:
                    return StepAction(action="click", elementId=plus.id, repeat=item.qty - 1, itemIndex=idx,
                                      targetText=_tap("plus", idx, product),
                                      reason=f"set {item.name} quantity to {item.qty}", source="fast")
                return None  # added, but the "+" isn't recognisable: let the LLM finish the quantity
            return StepAction(action="item_done", itemIndex=idx, itemOk=True, reason=f"{item.name} is in the cart",
                              source="fast")
        if product and _failed_adds(req, idx, product) >= MAX_ADD_TAPS:
            return StepAction(action="item_done", itemIndex=idx, itemOk=False,
                              reason=f"{item.name}: the store didn't add it after {MAX_ADD_TAPS} taps", source="guard")
        return None  # ADD still showing (size sheet, login prompt...) or unknown product: the LLM looks at it
    if tap and tap[1] == idx and tap[0] == "plus":
        return StepAction(action="item_done", itemIndex=idx, itemOk=True,
                          reason=f"{item.name} x{item.qty} is in the cart", source="fast")
    if _added_ok(req, idx):  # added earlier (then something else happened, e.g. a popup was closed)
        return StepAction(action="item_done", itemIndex=idx, itemOk=True, reason=f"{item.name} is in the cart",
                          source="fast")

    # 2. the matching product is on screen: add it
    add = _best_add(req, item)
    if add:
        return StepAction(action="click", elementId=add.id, itemIndex=idx, targetText=_tap("add", idx, _product(add)),
                          reason=f"add {_product(add)[:50]}", source="fast")

    # 3. get to the search results for this item
    # Typed this search within the last few steps: don't type it again (some apps don't expose the box's text, and
    # retyping wipes the results/suggestions that are loading). What to do with the results is the LLM's call.
    typed_now = any(h.action == "type" and (h.target or "") == f"search@{item.name}" for h in req.history[-6:])
    if req.mode == "app":
        box = next((e for e in req.elements if e.editable and not e.disabled), None)
        box_text = (box.text or "").lower() if box else ""
        already = item.name.lower() in box_text and "search" not in box_text  # (rotating hints say "Search for ...")
        if box and not typed_now and not already:
            return StepAction(action="type", elementId=box.id, text=item.name, submit=True, itemIndex=idx,
                              targetText=f"search@{item.name}", reason=f"search {item.name}", source="fast")
        if not box:
            search = next((e for e in req.elements if re.search(r"\bsearch\b", f"{e.text} {e.label or ''} {e.role or ''}", re.I)), None)
            if search and not any(h.target == "open-search" for h in req.history[-2:]):
                return StepAction(action="click", elementId=search.id, itemIndex=idx, targetText="open-search",
                                  reason="open search", source="fast")
        return None
    url = search_url(store_key(req.store), item.name)
    if url and url != req.url and not any(h.action == "navigate" and h.target == url for h in req.history[-2:]):
        return StepAction(action="navigate", url=url, itemIndex=idx, targetText=url, reason=f"search {item.name}",
                          source="fast")
    return None


def heuristic_step(req: StepRequest) -> StepAction:
    """When the LLM is unavailable: the fast path, else wait a little, else give up on the item."""
    action = fast_step(req)
    if action:
        action.source = "heuristic"
        return action
    idx = _current(req.items)
    stuck = sum(1 for h in req.history[-6:] if h.action in ("wait", "type", "navigate"))
    if idx is not None and stuck >= 4:
        return StepAction(action="item_done", itemIndex=idx, itemOk=False, reason="couldn't find it",
                          source="heuristic")
    return StepAction(action="wait", reason="waiting for the screen", source="heuristic")


def _normalise_id(action: StepAction, req: StepRequest) -> None:
    """Models sometimes answer 3 for "n3"/"e3"."""
    if action.elementId is not None and _element(req, str(action.elementId)) is None:
        digits = str(action.elementId).strip().lstrip("ne")
        match = next((e for e in req.elements if e.id.lstrip("ne") == digits), None)
        if match:
            action.elementId = match.id
    elif action.elementId is not None:
        action.elementId = str(action.elementId)


async def _ask_llm(req: StepRequest, system: str) -> StepAction:
    """Fast model first (short timeout), then the main model, then the no-LLM heuristic."""
    messages = [{"role": "system", "content": system}, {"role": "user", "content": _page_text(req)}]
    for model, timeout in ((settings.cart_agent_model, settings.shopping_agent_timeout_s),
                           (None, settings.shopping_agent_timeout_s + 10)):
        try:
            raw = await llm_service.chat_json(messages, model=model, timeout=timeout, retries=1)
            fields = {k: v for k, v in (raw or {}).items() if k in StepAction.model_fields and v is not None}
            if "elementId" in fields:
                fields["elementId"] = str(fields["elementId"])
            return StepAction(**fields)
        except (LLMServiceError, ValueError, TypeError) as exc:
            logger.warning("cart_agent_llm_failed", model=model or "default", error=str(exc)[:200])
    return heuristic_step(req)


async def next_step(req: StepRequest) -> StepAction:
    from app.services import shopping_history_reader as reader  # imports this module

    t0 = time.time()
    if req.phase == "history":
        action = await reader.history_step(req)
        _log_step(req, action, None, t0)
        return action
    if not req.items:
        return StepAction(action="done", message=f"Read {req.ordersRead} past orders; nothing to add.", source="fast")
    if not req.resolved:
        action = await reader.resolve_step(req)
        _log_step(req, action, None, t0)
        return action
    limit = MAX_STEPS_BASE + MAX_STEPS_PER_ITEM * len(req.items)
    idx = _current(req.items)
    if req.step >= limit:
        action = StepAction(action="done", message=f"Stopped after {req.step} steps; check the cart.", source="guard")
    else:
        action = fast_step(req)
        if action is None:
            key = store_key(req.store)
            current = f"{idx}: {req.items[idx].name} x{req.items[idx].qty}" if idx is not None else "none - all items handled"
            if req.mode == "app":
                system = _APP_PROMPT.format(store=req.store, items=_items_text(req.items), current=current,
                                            app_hint=STORES.get(key or "", {}).get("appHint") or "")
            else:
                hint = f" like {search_url(key, 'ITEM')}" if key else ""
                system = _STEP_PROMPT.format(store=req.store, items=_items_text(req.items), current=current,
                                             search_hint=hint)
            action = await _ask_llm(req, system)
            _normalise_id(action, req)
            if action.itemIndex is None and action.action in ("item_done", "click"):
                action.itemIndex = idx
            el = _element(req, action.elementId)
            if action.action == "click" and el is not None and not action.targetText:
                if _is_add(el) and idx is not None:
                    action.targetText = _tap("add", idx, _product(el))
                elif _PLUS.match((el.text or el.label or "").strip()) and idx is not None:
                    action.targetText = _tap("plus", idx, _product(el))
                else:
                    action.targetText = (el.text or el.label or el.id)[:60]
            if action.action == "type" and idx is not None:
                cur = req.items[idx]
                other = next((i for i, it in enumerate(req.items) if i != idx and it.status == "pending"
                              and _same_item((action.text or "").lower(), it)), None)
                if other is not None:
                    # the LLM considers the current item finished and moved on: record that first, so the
                    # fast path doesn't search for it again (and add it twice)
                    ok = _added_ok(req, idx)
                    action = StepAction(action="item_done", itemIndex=idx, itemOk=ok,
                                        reason=f"{cur.name} {'is in the cart' if ok else 'could not be added'}",
                                        source="llm")
                else:
                    action.targetText = f"search@{cur.name}"
    tap = _parse_tap(action.targetText) if action.action == "click" else None
    if tap and tap[0] == "add" and idx is not None and _failed_adds(req, idx, tap[2]) >= MAX_ADD_TAPS:
        action = StepAction(action="item_done", itemIndex=idx, itemOk=False,
                            reason=f"{req.items[idx].name}: the store didn't add it after {MAX_ADD_TAPS} taps", source="guard")
    elif tap and tap[0] == "add" and idx is not None and _added_ok(req, idx):
        action = StepAction(action="item_done", itemIndex=idx, itemOk=True,
                            reason=f"{req.items[idx].name} is already in the cart", source="guard")
    action = guard(action, req)
    _log_step(req, action, idx, t0)
    return action


def _log_step(req: StepRequest, action: StepAction, idx: int | None, t0: float) -> None:
    logger.info("cart_agent_step", store=req.store, mode=req.mode, phase=req.phase, step=req.step,
                item=req.items[idx].name if idx is not None else None, action=action.action,
                element=action.elementId, target=action.targetText, source=action.source, reason=action.reason[:100],
                orders=action.ordersSaved or None, ms=int((time.time() - t0) * 1000))
