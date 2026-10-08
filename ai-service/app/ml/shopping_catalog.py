"""Canonical shopping items, categories and stores shared by the synthetic generator, training and serving.

A user's free text ("Amul taaza milk 1L", "2 packs of maggi") is mapped to a canonical item ("milk",
"instant noodles") so history from different phrasings and stores adds up. Anything not in the catalog
keeps its own cleaned name and the category "other"; the model still learns its repeat pattern from
that user's own history, it just has no catalog prior.
"""
from __future__ import annotations

import re
from difflib import get_close_matches
from functools import lru_cache

# item -> (category, typical repurchase cycle in days, typical unit price INR, keywords)
# cycle_days None = not a repeat purchase (bought once in a while: electronics, fashion...)
CATALOG: dict[str, tuple[str, float | None, float, tuple[str, ...]]] = {
    # daily fresh
    "milk": ("dairy", 2, 34, ("milk", "doodh", "toned milk", "taaza")),
    "bread": ("bakery", 4, 50, ("bread", "pav", "bun")),
    "eggs": ("dairy", 6, 90, ("egg", "eggs", "anda")),
    "curd": ("dairy", 4, 45, ("curd", "dahi", "yogurt", "yoghurt")),
    "paneer": ("dairy", 8, 95, ("paneer", "cottage cheese")),
    "butter": ("dairy", 18, 60, ("butter",)),
    "cheese": ("dairy", 14, 110, ("cheese", "cheese slices", "cheese spread", "mozzarella")),
    "bananas": ("fruits_vegetables", 5, 60, ("banana", "bananas", "kela")),
    "apples": ("fruits_vegetables", 8, 180, ("apple", "apples")),
    "onions": ("fruits_vegetables", 7, 45, ("onion", "onions", "pyaz", "kanda")),
    "tomatoes": ("fruits_vegetables", 5, 40, ("tomato", "tomatoes", "tamatar")),
    "potatoes": ("fruits_vegetables", 8, 40, ("potato", "potatoes", "aloo")),
    "green vegetables": ("fruits_vegetables", 4, 50, ("spinach", "palak", "coriander", "dhania", "vegetable",
                                                     "vegetables", "sabzi", "chilli", "chillies", "capsicum")),
    # staples
    "atta": ("staples", 25, 320, ("atta", "wheat flour", "flour")),
    "rice": ("staples", 28, 450, ("rice", "basmati", "chawal")),
    "dal": ("staples", 20, 160, ("dal", "toor", "moong", "masoor", "lentil", "lentils", "chana")),
    "cooking oil": ("staples", 25, 190, ("oil", "cooking oil", "sunflower oil", "mustard oil", "ghee")),
    "sugar": ("staples", 30, 50, ("sugar", "cheeni", "jaggery")),
    "tea": ("beverages", 30, 280, ("tea", "chai", "chai patti")),
    "coffee": ("beverages", 30, 350, ("coffee", "nescafe", "bru")),
    "spices": ("staples", 45, 90, ("masala", "spice", "spices", "turmeric", "haldi", "salt", "jeera")),
    # snacks & drinks
    "instant noodles": ("snacks", 9, 60, ("maggi", "noodles", "instant noodles", "yippee", "ramen", "cup noodles")),
    "chips": ("snacks", 7, 40, ("chips", "lays", "kurkure", "namkeen", "bhujia", "mixture", "nachos", "wafers")),
    "biscuits": ("snacks", 8, 35, ("biscuit", "biscuits", "cookies", "oreo", "parle")),
    "chocolates": ("snacks", 10, 80, ("chocolate", "chocolates", "dairy milk", "kitkat")),
    "soft drinks": ("beverages", 7, 90, ("coke", "pepsi", "soft drink", "cold drink", "sprite", "soda")),
    "juice": ("beverages", 9, 120, ("juice", "tropicana", "real juice")),
    "ice cream": ("snacks", 12, 150, ("ice cream", "icecream", "kulfi")),
    # household
    "detergent": ("household", 30, 250, ("detergent", "surf", "ariel", "tide", "washing powder")),
    "dishwash": ("household", 25, 120, ("dishwash", "vim", "dish wash", "dish soap")),
    "toilet cleaner": ("household", 35, 110, ("toilet cleaner", "harpic")),
    "floor cleaner": ("household", 35, 140, ("floor cleaner", "lizol", "phenyl")),
    "garbage bags": ("household", 30, 99, ("garbage bag", "garbage bags", "dustbin bag", "trash bag")),
    "tissues": ("household", 20, 120, ("tissue", "tissues", "napkin", "napkins", "toilet paper")),
    # personal care
    "toothpaste": ("personal_care", 35, 110, ("toothpaste", "colgate", "pepsodent", "sensodyne")),
    "soap": ("personal_care", 25, 160, ("soap", "body wash", "dettol", "lux")),
    "shampoo": ("personal_care", 40, 280, ("shampoo", "conditioner")),
    "face wash": ("personal_care", 40, 230, ("face wash", "facewash", "cleanser")),
    "deodorant": ("personal_care", 45, 250, ("deodorant", "deo", "perfume")),
    "sanitary pads": ("personal_care", 28, 320, ("sanitary", "pads", "whisper", "stayfree", "tampon")),
    # baby & pet
    "diapers": ("baby", 10, 750, ("diaper", "diapers", "pampers", "huggies")),
    "baby wipes": ("baby", 14, 199, ("wipes", "baby wipes")),
    "baby food": ("baby", 15, 380, ("cerelac", "baby food", "formula")),
    "dog food": ("pet", 25, 850, ("dog food", "pedigree", "pet food", "cat food", "whiskas")),
    # health
    "protein powder": ("health", 40, 2400, ("protein", "whey", "protein powder")),
    "multivitamins": ("health", 30, 550, ("vitamin", "vitamins", "multivitamin", "multivitamins")),
    "medicines": ("health", 30, 200, ("medicine", "medicines", "paracetamol", "crocin", "dolo", "tablet")),
    # occasional (not a repeat cycle)
    "phone charger": ("electronics", None, 900, ("charger", "cable", "usb cable")),
    "earbuds": ("electronics", None, 1800, ("earbuds", "earphones", "headphones", "airpods", "buds")),
    "power bank": ("electronics", None, 1500, ("power bank", "powerbank")),
    "led bulb": ("home", None, 120, ("bulb", "led bulb", "light bulb", "tubelight")),
    "batteries": ("electronics", None, 150, ("battery", "batteries", "aa battery")),
    "t-shirt": ("fashion", None, 600, ("t-shirt", "tshirt", "tee")),
    "jeans": ("fashion", None, 1600, ("jeans", "denim")),
    "sneakers": ("fashion", None, 2800, ("sneakers", "shoes", "running shoes", "trainers")),
    "kurta": ("fashion", None, 1200, ("kurta", "kurti")),
    "bedsheet": ("home", None, 800, ("bedsheet", "bed sheet", "pillow cover")),
    "books": ("books", None, 400, ("book", "books", "novel")),
}

CATEGORIES = sorted({c for c, *_ in CATALOG.values()} | {"other"})

QUICK = ["Blinkit", "Zepto", "Swiggy Instamart"]
GROCERY = ["BigBasket", "JioMart"]
MARKET = ["Amazon", "Flipkart"]
FASHION = ["Myntra"]
APPS = QUICK + GROCERY + MARKET + FASHION

# Which stores sell which categories (used by the generator; serving only uses the user's own history).
CATEGORY_APPS: dict[str, list[str]] = {
    "dairy": QUICK + GROCERY, "bakery": QUICK + GROCERY, "fruits_vegetables": QUICK + GROCERY,
    "staples": QUICK + GROCERY + MARKET, "beverages": QUICK + GROCERY + MARKET, "snacks": QUICK + GROCERY,
    "household": QUICK + GROCERY + MARKET, "personal_care": QUICK + GROCERY + MARKET,
    "baby": QUICK + GROCERY + MARKET, "pet": QUICK + MARKET, "health": QUICK + MARKET,
    "electronics": MARKET + ["Blinkit"], "home": MARKET + ["Blinkit"], "fashion": FASHION + MARKET,
    "books": MARKET, "other": QUICK + MARKET,
}

_APP_ALIASES = {
    "blinkit": "Blinkit", "grofers": "Blinkit", "zepto": "Zepto", "instamart": "Swiggy Instamart",
    "swiggy instamart": "Swiggy Instamart", "swiggy": "Swiggy Instamart", "bigbasket": "BigBasket",
    "big basket": "BigBasket", "bb": "BigBasket", "jiomart": "JioMart", "jio mart": "JioMart",
    "amazon": "Amazon", "amazon fresh": "Amazon", "flipkart": "Flipkart", "flipkart minutes": "Flipkart",
    "myntra": "Myntra", "aura": "AURA", "zomato": "Zomato",
    "ajio": "AJIO", "nykaa": "Nykaa", "meesho": "Meesho", "tata 1mg": "Tata 1mg", "1mg": "Tata 1mg",
    "pharmeasy": "PharmEasy", "croma": "Croma", "dmart": "DMart Ready", "dmart ready": "DMart Ready",
    # how speech recognition tends to write them
    "blink it": "Blinkit", "blinket": "Blinkit", "blinkid": "Blinkit", "blanket": "Blinkit",
    "zapto": "Zepto", "zapdo": "Zepto", "zepdo": "Zepto", "jepto": "Zepto", "septo": "Zepto", "zeptoh": "Zepto",
    "insta mart": "Swiggy Instamart", "instamat": "Swiggy Instamart", "swiggi": "Swiggy Instamart",
    "jomato": "Zomato", "zomatto": "Zomato", "somato": "Zomato", "flip kart": "Flipkart", "mintra": "Myntra",
    "nika": "Nykaa", "nykaa fashion": "Nykaa", "misho": "Meesho", "big bucket": "BigBasket",
}
_COMPACT_ALIASES = {re.sub(r"[^a-z0-9]", "", k): v for k, v in _APP_ALIASES.items()}

_KEYWORDS = sorted(((kw, item) for item, (*_, kws) in CATALOG.items() for kw in kws), key=lambda x: -len(x[0]))
_QTY_WORDS = re.compile(r"\b(\d+(\.\d+)?\s*(kg|g|gm|gms|l|ltr|litre|liter|ml|pc|pcs|pack|packs|packet|packets|dozen|x)?)\b",
                        re.I)


@lru_cache(maxsize=4096)
def canonical_app(name: str | None) -> str:
    if not name:
        return "none"
    key = re.sub(r"\s+", " ", str(name).strip().lower())
    if key in _APP_ALIASES:
        return _APP_ALIASES[key]
    # spoken commands arrive misspelt or split ("blink it", "zapdo", "big basket app"): ignore spacing and
    # filler words, then take the closest known store if it is close enough
    compact = re.sub(r"[^a-z0-9]", "", re.sub(r"\b(app|store|the|website|site|india)\b", " ", key))
    if compact in _COMPACT_ALIASES:
        return _COMPACT_ALIASES[compact]
    if len(compact) >= 4:
        close = get_close_matches(compact, list(_COMPACT_ALIASES), n=1, cutoff=0.8)
        if close:
            return _COMPACT_ALIASES[close[0]]
    return str(name).strip()


_KW_RES = [(re.compile(rf"(?<![a-z0-9]){re.escape(kw)}(?:s|es)?(?![a-z0-9])"), kw, item) for kw, item in _KEYWORDS]
# where a product's own name ends and its description starts: "Sid's Farm Curd - made from tested milk",
# "Amul Taaza Toned Milk (Tetra Pack)", "Lay's Potato Chips, 1 pack". A "|" usually separates brand line and
# product type ("Lay's Tomato Tango | Potato Chips"), so it stays inside the name.
_DESCRIPTION = re.compile(r"\s[-–—]\s|\(|,|\bmade (from|with)\b|\bwith\b")


def _type_keyword(text: str) -> str | None:
    """The product type: the keyword that ends LAST in the name (grocery names end with the noun: "English Oven
    Milk Bread" is bread, "Milk Bikis Biscuits" is biscuits, "Tomato Tango Potato Chips" is chips). Whole words
    only ("Haldiram's" is not "haldi"); at the same end position the longer keyword wins ("toned milk")."""
    best, best_end, best_len = None, -1, 0
    for rx, kw, item in _KW_RES:
        for m in rx.finditer(text):
            if m.end() > best_end or (m.end() == best_end and len(kw) > best_len):
                best, best_end, best_len = item, m.end(), len(kw)
    return best


@lru_cache(maxsize=50_000)
def canonical_item(name: str | None) -> str:
    """'Amul Taaza toned milk 1L' -> 'milk', 'Country Delight | Ghar Jaisa Dahi Cup' -> 'curd';
    unknown items -> cleaned lowercase text."""
    if not name:
        return "none"
    text = re.sub(r"[^a-z0-9\s|(),&-]", " ", str(name).lower().replace("'", ""))
    head = _DESCRIPTION.split(text, maxsplit=1)[0]
    found = _type_keyword(head) or _type_keyword(text)
    if found:
        return found
    cleaned = re.sub(r"[|(),&]", " ", text)
    cleaned = re.sub(r"\s+", " ", _QTY_WORDS.sub(" ", cleaned)).strip(" -")
    return cleaned[:60] or "none"


RESTAURANT_FOOD = "restaurant_food"
FOOD_APPS = {"Zomato", "Swiggy", "EatSure", "Dominos", "Domino's"}


def dish_item(name: str | None) -> str:
    """A restaurant dish as an item: its own cleaned name ('Soya Chaap Biriyani Bowl' -> 'soya chaap biriyani bowl')."""
    if not name:
        return "none"
    text = re.sub(r"[^a-z0-9\s&-]", " ", str(name).lower().replace("'", ""))
    return re.sub(r"\s+", " ", text).strip(" -")[:60] or "none"


def item_category(item: str) -> str:
    entry = CATALOG.get(item)
    return entry[0] if entry else "other"


def item_cycle(item: str) -> float | None:
    entry = CATALOG.get(item)
    return entry[1] if entry else None


def item_price(item: str) -> float | None:
    entry = CATALOG.get(item)
    return entry[2] if entry else None
