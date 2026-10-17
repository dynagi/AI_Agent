"""Customisation sheets in food apps (size, crust, toppings, add-ons): reading their groups from the screen, the
question AURA asks about them, and turning the user's answer into the options to select.

The cart agent (shopping_browser) drives the conversation; this module only knows about sheets. A sheet is read from
the store app's screen elements: option rows carry `checked` (the state of the radio button / checkbox inside them)
and `checkKind` ("radio" or "check"); the rows before them without one are the group headers ("Size Required •
Select any 1 option", "Toppings-Veg (regular)").
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any

_PRICE = re.compile(r"₹\s?([\d,]+(?:\.\d+)?)")
# the part of a header that states the rule: "Required • Select any 1 option", "Select up to 2 options", "Optional"
_RULE = re.compile(r"\b(required|optional|(?:select|choose|pick)\s+(?:any\s+|up\s*to\s+|upto\s+|min(?:imum)?\s+|max(?:imum)?\s+)?\d+)\b.*$",
                   re.I)
_UP_TO = re.compile(r"\b(?:up\s*to|upto|max(?:imum)?)\s+(\d+)", re.I)
_ANY_N = re.compile(r"\b(?:select|choose|pick)\s+(?:any\s+)?(\d+)\b", re.I)
_CONFIRM = re.compile(r"^\s*(add item|add items|add to cart|add to order|update item)\b", re.I)
_CANCEL = re.compile(r"\b(cancel|don'?t add|do not add|leave it|never ?mind|forget it|stop)\b", re.I)
_NONE = re.compile(r"\b(no|none|nothing|without)\b[^.?!]*\b(add-?ons?|toppings?|extras?|else|more)\b|"
                   r"^\s*(no|none|nothing|that'?s it|just that|as it is|default)\s*[.!]?\s*$", re.I)
_YES = re.compile(r"^\s*(yes|yeah|yep|yup|ok|okay|sure|go ahead|add it|do it|haan|ha|ji|correct|right|confirm)\b", re.I)
_NO = re.compile(r"^\s*(no|nope|nah|nahi|wait|change)\b", re.I)


@dataclass
class Option:
    name: str
    price: float | None = None
    checked: bool = False
    id: str | None = None   # element id on the current screen (not kept across screens)
    page: int = 0           # how far down the sheet it was seen (scrolls from the top)


@dataclass
class Group:
    name: str
    required: bool = False
    max: int = 0            # 0 = no limit
    single: bool = False    # radio buttons: choosing one replaces the other
    options: list[Option] = field(default_factory=list)
    cont: bool = False      # started without a header on this screen: may continue the previous screen's last group


def _split_price(text: str) -> tuple[str, float | None]:
    prices = _PRICE.findall(text)
    name = _PRICE.sub("", text).strip(" -•·|,")
    price = float(prices[-1].replace(",", "")) if prices else None   # with a discount the last one is what's paid
    return re.sub(r"\s+", " ", name), price


def _header(text: str) -> Group:
    m = _RULE.search(text)
    name = (text[:m.start()] if m else text).strip(" -•·|")
    rule = text[m.start():] if m else ""
    g = Group(name=name or "Options", required=bool(re.search(r"\brequired\b", rule, re.I)))
    up_to, any_n = _UP_TO.search(rule), _ANY_N.search(rule)
    if up_to:
        g.max = int(up_to.group(1))
    elif any_n:
        g.max = int(any_n.group(1))
        g.single = g.max == 1
    return g


def _text(e: Any) -> str:
    return re.sub(r"\s+", " ", (getattr(e, "text", "") or getattr(e, "label", "") or "")).strip()


def read_sheet(elements: list[Any], page: int = 0) -> list[Group]:
    """The groups and options of the sheet on this screen, top to bottom."""
    groups: list[Group] = []
    header: str | None = None
    for e in elements:
        text = _text(e)
        if not text or text.lower().startswith("unlabeled icon") or _CONFIRM.match(text):
            continue
        checked = getattr(e, "checked", None)
        if checked is not None and _RULE.search(text):
            continue    # a container around a whole group ("Crust Required • 1 option … Cheese Burst …"), not an option
        if checked is None:
            # a row without a checkbox: a group header if it has words and no price ("Size Required • Select any 1")
            if re.search(r"[A-Za-z]{2}", text) and not _PRICE.search(text) and len(text) <= 90:
                header = text
            continue
        name, price = _split_price(text)
        if not name:
            continue
        if header is not None or not groups:
            g = _header(header) if header is not None else Group(name="Options", cont=True)
            groups.append(g)
            header = None
        g = groups[-1]
        if getattr(e, "checkKind", None) == "radio":
            g.single = True
        g.options.append(Option(name=name, price=price, checked=bool(checked), id=getattr(e, "id", None), page=page))
    return [g for g in groups if g.options]


def merge(seen: list[Group], screen: list[Group]) -> tuple[list[Group], bool]:
    """Adds a newly scrolled-to screen to what was seen before. Returns (groups, anything new)."""
    out = [Group(**{**g.__dict__, "options": list(g.options)}) for g in seen]
    new = False
    for g in screen:
        target = next((o for o in out if o.name.lower() == g.name.lower() and not g.cont), None)
        if target is None and g.cont and out:
            target = out[-1]        # options at the top of the screen with their header scrolled away
        if target is None:
            out.append(Group(**{**g.__dict__, "options": [], "cont": False}))
            target = out[-1]
            new = True
        for o in g.options:
            if not any(x.name.lower() == o.name.lower() for x in target.options):
                target.options.append(o)
                new = True
    return out, new


# ---------------------------------------------------------------------- carried between steps (in history records)
def dump(groups: list[Group]) -> str:
    return json.dumps([{"n": g.name, "r": int(g.required), "m": g.max, "s": int(g.single),
                        "o": [[o.name, o.price, int(o.checked), o.page] for o in g.options]} for g in groups],
                      ensure_ascii=False, separators=(",", ":"))


def load(text: str) -> list[Group]:
    try:
        data = json.loads(text)
        return [Group(name=g["n"], required=bool(g["r"]), max=int(g["m"]), single=bool(g["s"]),
                      options=[Option(name=o[0], price=o[1], checked=bool(o[2]), page=int(o[3])) for o in g["o"]])
                for g in data]
    except (ValueError, KeyError, TypeError, IndexError):
        return []


# ---------------------------------------------------------------------- the question
def _rupees(p: float | None) -> str:
    if p is None:
        return ""
    return f"₹{int(p)}" if float(p).is_integer() else f"₹{p:.2f}"


def _choices(opts: list[Option], limit: int = 6) -> str:
    prices = {o.price for o in opts}
    if len(prices) == 1 and len(opts) > 2 and None not in prices:
        names = [o.name for o in opts[:limit]]
        more = f" and {len(opts) - limit} more" if len(opts) > limit else ""
        return f"{', '.join(names)}{more}, {_rupees(opts[0].price)} each"
    parts = [f"{o.name} {_rupees(o.price)}".strip() for o in opts[:limit]]
    more = f", and {len(opts) - limit} more" if len(opts) > limit else ""
    return (", ".join(parts[:-1]) + " or " + parts[-1] if len(parts) > 1 else parts[0]) + more


def to_choose(groups: list[Group]) -> list[Group]:
    """Groups the user actually has a choice in (a required group with a single option is just shown)."""
    return [g for g in groups if len(g.options) > 1 or not g.required]


def question(dish: str, groups: list[Group]) -> str | None:
    """One spoken question covering every choice on the sheet. None when there is nothing to choose."""
    ask = to_choose(groups)
    if not ask:
        return None
    lines = []
    for g in ask:
        picked = [o.name for o in g.options if o.checked]
        now = f" ({picked[0]} is selected)" if g.required and picked else ""
        lines.append(f"{g.name}{' (optional)' if not g.required else ''}: {_choices(g.options)}{now}.")
    must = [g.name.lower() for g in ask if g.required]
    ending = (f"Which {' and '.join(must)}" + (", and any extras?" if any(not g.required for g in ask) else "?")) \
        if must else "Want any of these, or none?"
    return f"{dish} has options. " + " ".join(lines) + " " + ending


# ---------------------------------------------------------------------- understanding the answer
def cancelled(answer: str) -> bool:
    return bool(_CANCEL.search(answer or ""))


def yes(answer: str) -> bool:
    return bool(_YES.match(answer or "")) and not _NO.match(answer or "")


def plain_no(answer: str) -> bool:
    """"No" with nothing else in it (not "no, make it medium")."""
    return bool(re.fullmatch(r"\s*(no|nope|nah|nahi|no thanks|no thank you)\s*[.!]?\s*", answer or "", re.I))


def _words(s: str) -> set[str]:
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 2 and w not in {"the", "and", "with", "pizza", "serves"}}


def rule_plan(answer: str, groups: list[Group]) -> dict[str, list[str]]:
    """Fallback without the AI: options named in the answer (by their distinctive words)."""
    said = _words(answer)
    plan: dict[str, list[str]] = {}
    no_extras = bool(_NONE.search(answer or ""))
    for g in groups:
        hits = []
        for o in g.options:
            key = _words(o.name)
            first = next(iter(re.findall(r"[a-z0-9]+", o.name.lower())), "")
            if key and (first in said or len(key & said) >= max(1, len(key) // 2)):
                hits.append(o.name)
        if g.single or g.max == 1:
            hits = hits[:1]
        elif g.max:
            hits = hits[:g.max]
        if hits:
            plan[g.name] = hits
        elif not g.required and no_extras:
            plan[g.name] = []
    return plan


def clean_plan(raw: dict, groups: list[Group]) -> dict[str, list[str]]:
    """Keeps only real groups and options (the model may paraphrase names) and the sheet's limits."""
    plan: dict[str, list[str]] = {}
    for g in groups:
        picked = next((v for k, v in (raw or {}).items() if isinstance(k, str) and k.strip().lower() == g.name.lower()), None)
        if picked is None:
            continue
        names = []
        for want in picked if isinstance(picked, list) else [picked]:
            if not isinstance(want, str):
                continue
            o = next((o for o in g.options if o.name.lower() == want.strip().lower()), None) \
                or next((o for o in g.options if want.strip().lower() in o.name.lower() and len(want.strip()) >= 3), None)
            if o and o.name not in names:
                names.append(o.name)
        if g.single or g.max == 1:
            names = names[:1]
        elif g.max:
            names = names[:g.max]
        if names or not g.required:
            plan[g.name] = names
    return plan


def llm_messages(dish: str, groups: list[Group], answer: str) -> list[dict]:
    sheet = "\n".join(
        f"- {g.name} ({'required' if g.required else 'optional'}, "
        f"{'choose one' if g.single or g.max == 1 else f'up to {g.max}' if g.max else 'any number'}): "
        + "; ".join(f"{o.name}{' [selected now]' if o.checked else ''}" for o in g.options)
        for g in groups)
    return [
        {"role": "system", "content": (
            "You map a customer's spoken answer to options on a food app's customisation sheet. Reply with JSON only: "
            '{"cancel": false, "choices": {"<group name>": ["<option name exactly as listed>", ...]}}. '
            "Include a group only if the answer says something about it; an empty list means none from that group "
            "(e.g. 'no toppings', 'nothing else' empties the optional groups). Never invent options. "
            "cancel=true only if they don't want the dish at all.")},
        {"role": "user", "content": f"Dish: {dish}\nSheet:\n{sheet}\n\nCustomer said: {answer}"},
    ]


def desired(groups: list[Group], plan: dict[str, list[str]]) -> dict[str, dict[str, bool]]:
    """For every group the answer covers: option name -> should it be selected."""
    out: dict[str, dict[str, bool]] = {}
    for g in groups:
        if g.name not in plan:
            continue
        want = set(plan[g.name])
        if g.single and not want:
            continue        # a single-choice group can't be emptied: keep what is selected
        out[g.name] = {o.name: o.name in want for o in g.options}
    return out


def summary(dish: str, groups: list[Group], plan: dict[str, list[str]]) -> str:
    """"Margherita Pizza, Medium (serves 2, 25 Cm), with Paneer" from the plan plus what stays selected."""
    picks = []
    for g in groups:
        if g.name in plan:
            names = plan[g.name] or ([o.name for o in g.options if o.checked] if g.single else [])
        else:
            names = [o.name for o in g.options if o.checked]
        picks.append((g, names))
    main = [n for g, names in picks if g.required for n in names]
    extras = [n for g, names in picks if not g.required for n in names]
    text = dish + (", " + ", ".join(main) if main else "")
    return text + (", with " + " and ".join(extras) if extras else ", no extras")
