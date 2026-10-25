"""Hinglish (and simple Hindi) commands rewritten as the English commands AURA's rules understand, so every feature
works the same in both: "Mujhe Delhi se Pune ki cheapest flight dikha" -> "find me the cheapest flight from Delhi to
Pune". Only the command structure changes: names, places, products and message text are kept as said. The original
sentence is still used to pick the reply language. The same rules exist on the phone (Hinglish.java) and in the app
(hinglish.ts)."""
from __future__ import annotations

import re

_V = r"(?:kar(?:\s?(?:o|do|de|dena|na|dijiye))?|kardo|karde)"            # "kar / karo / kar do / kar de"
_SHOW = r"(?:dikha(?:o|do|de)?|batao|bata(?:o|do|de)?|chahiye|dhundo|dhoondo|search kar(?:o|do|de)?)"
_GROCERY = {"doodh": "milk", "dudh": "milk", "anda": "eggs", "ande": "eggs", "chini": "sugar", "cheeni": "sugar",
            "chawal": "rice", "aata": "atta", "dahi": "curd", "makhan": "butter", "namak": "salt", "pyaz": "onion",
            "pyaaz": "onion", "aloo": "potato", "tamatar": "tomato", "sabzi": "vegetables", "chai patti": "tea",
            "kele": "banana", "kela": "banana", "seb": "apple"}
_FILLER = re.compile(r"^(?:hey aura,?\s+|aura,?\s+)?(?:please\s+|zara\s+|jaldi\s+)?(?:mere liye\s+|mujhe\s+|hamare liye\s+)?", re.I)


def _items(text: str) -> str:
    out = text
    for hi, en in _GROCERY.items():
        out = re.sub(rf"\b{hi}\b", en, out, flags=re.I)
    return re.sub(r"\s+\b(ka|ki|ke)\b\s+", " ", f" {out} ").strip()


RULES: list[tuple[re.Pattern, object]] = [
    # past orders: "maine last time kya order kiya tha", "mera pichla order kya tha"
    (re.compile(r"(?:maine )?(?:last time|pichli baar|pichhli baar|pichle baar) kya (?:order|mangaya|mangwaya)|"
                r"(?:mera|meri) (?:pichla|pichhla|last) order (?:kya|kaunsa)", re.I),
     lambda m, t: "what did I order last time"),
    # travel: "Delhi se Pune ki cheapest flight dikha", "kal Bangalore se Chennai ki bus"
    (re.compile(r"(?:(kal|parso|aaj)\s+)?([a-z][a-z ]{1,25}?) se ([a-z][a-z ]{1,25}?) (?:ki|ka|ke|tak ki|tak ka)?\s*"
                r"(sasti |sabse sasti |cheapest |direct )?(flight|train|bus|cab|taxi)\b(?:.*?\b(kal|parso|aaj)\b)?", re.I),
     lambda m, t: "find me the {cheap}{mode} from {a} to {b}{when}".format(
         cheap="cheapest " if (m.group(4) or "").strip() in ("sasti", "sabse sasti", "cheapest") else
         ("direct " if (m.group(4) or "").strip() == "direct" else ""),
         mode=m.group(5).lower(), a=m.group(2).strip().title(), b=m.group(3).strip().title(),
         when={"kal": " tomorrow", "parso": " day after tomorrow", "aaj": " today"}.get(
             (m.group(1) or m.group(6) or "").lower(), ""))),
    # price: "Blinkit par milk ka price check kar"
    (re.compile(rf"(\w+) (?:par|pe) (.+?) (?:ka |ki |ke )?(?:price|daam|rate|keemat) (?:check |dekh |bata)?{_V}?", re.I),
     lambda m, t: f"check the price of {_items(m.group(2))} on {m.group(1)}"),
    (re.compile(rf"(.+?) (?:ka |ki |ke )?(?:price|daam|rate|keemat) (?:kya hai|kitna hai|check {_V}|batao)", re.I),
     lambda m, t: f"how much does {_items(m.group(1))} cost online"),
    # orders: "doodh order kar de", "2 ande mangwa do"
    (re.compile(rf"(.+?) (?:order {_V}|mangwa(?:\s?(?:o|do|de))?|manga(?:\s?(?:o|do|de))?|cart me(?:in)? daal(?:\s?(?:o|do|de))?)$", re.I),
     lambda m, t: f"order {_items(m.group(1))}"),
    # web search: "AI news search karo", "latest AI news dikhao"
    (re.compile(rf"(.+?) (?:google |online |internet par )?(?:search {_V}|dhundo|dhoondo|khojo)$", re.I),
     lambda m, t: f"search for {m.group(1)}"),
]


def to_english(text: str) -> str:
    """The English command for a Hinglish sentence; the sentence unchanged when no rule applies."""
    t = re.sub(r"[?.!]+$", "", (text or "").strip())
    body = _FILLER.sub("", t)
    for pattern, build in RULES:
        m = pattern.search(body)
        if m:
            return build(m, body)
    return text


def is_hinglish(text: str) -> bool:
    return bool(re.search(r"[ऀ-ॿ]", text or "")) or bool(re.search(
        r"\b(maine|mera|mere|mujhe|kitn[aei]|kitne|kya|aaj|hai|hain|kar|karo|kardo|chala|chalao|dikha|dikhao|bhej|"
        r"bhejo|ko|par|pe|se|ki|ka|mangwa|mangwao|khol|kholo|batao|chahiye|nahi|haan)\b", text or "", re.I))
