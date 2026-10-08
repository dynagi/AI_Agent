"""City names -> airport codes for flight search, covering every destination the travel model knows.
Places without a (well-served) airport map to the nearest one, noted in `via`."""
from __future__ import annotations

import re

# city: (IATA, nearest-airport note or None)
AIRPORTS: dict[str, tuple[str, str | None]] = {
    "Mumbai": ("BOM", None), "Delhi": ("DEL", None), "Bangalore": ("BLR", None), "Hyderabad": ("HYD", None),
    "Chennai": ("MAA", None), "Pune": ("PNQ", None), "Kolkata": ("CCU", None), "Ahmedabad": ("AMD", None),
    "Jaipur": ("JAI", None), "Kochi": ("COK", None), "Lucknow": ("LKO", None), "Chandigarh": ("IXC", None),
    "Goa": ("GOI", None), "Udaipur": ("UDR", None), "Varanasi": ("VNS", None), "Leh": ("IXL", None),
    "Port Blair": ("IXZ", None), "Amritsar": ("ATQ", None), "Agra": ("AGR", None),
    "Manali": ("KUU", "Bhuntar (Kullu), ~50 km by road"), "Shimla": ("SLV", "Shimla airport has few flights; Chandigarh is ~115 km"),
    "Munnar": ("COK", "Kochi, ~110 km by road"), "Rishikesh": ("DED", "Dehradun, ~35 km by road"),
    "Darjeeling": ("IXB", "Bagdogra, ~70 km by road"), "Pondicherry": ("MAA", "Chennai, ~150 km by road"),
    "Coorg": ("IXE", "Mangalore, ~140 km by road"), "Lonavala": ("PNQ", "Pune, ~65 km by road"),
    "Mysore": ("BLR", "Bangalore, ~150 km by road"), "Ooty": ("CJB", "Coimbatore, ~90 km by road"),
    "Mahabaleshwar": ("PNQ", "Pune, ~120 km by road"),
    "Dubai": ("DXB", None), "Singapore": ("SIN", None), "Bangkok": ("BKK", None), "Bali": ("DPS", None),
    "Maldives": ("MLE", None), "London": ("LHR", None), "Paris": ("CDG", None),
}

ALIASES = {"bengaluru": "Bangalore", "bombay": "Mumbai", "new delhi": "Delhi", "madras": "Chennai",
           "calcutta": "Kolkata", "cochin": "Kochi", "puducherry": "Pondicherry", "pondy": "Pondicherry",
           "kodagu": "Coorg", "mysuru": "Mysore", "udhagamandalam": "Ooty", "benaras": "Varanasi",
           "banaras": "Varanasi", "ladakh": "Leh", "andaman": "Port Blair"}

_NAMES = {c.lower(): c for c in AIRPORTS} | ALIASES
_PATTERN = re.compile(r"\b(" + "|".join(sorted(map(re.escape, _NAMES), key=len, reverse=True)) + r")\b", re.I)


def canonical_city(name: str | None) -> str | None:
    if not name:
        return None
    return _NAMES.get(name.strip().lower(), name.strip().title())


def airport_for(city: str | None) -> tuple[str | None, str | None]:
    """(IATA, note) for a known city, else (None, None)."""
    return AIRPORTS.get(canonical_city(city) or "", (None, None))


def cities_in(text: str) -> list[str]:
    """Known cities mentioned in free text, in order of appearance."""
    seen: list[str] = []
    for m in _PATTERN.finditer(text):
        c = _NAMES[m.group(1).lower()]
        if c not in seen:
            seen.append(c)
    return seen
