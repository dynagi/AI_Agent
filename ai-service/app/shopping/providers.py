"""Shopping providers: one interface, many stores.

The agent core never names a store. It asks the registry which providers are relevant to a product and works with
whatever they report. A provider says what it can do through `capabilities`, and `search` must return either real
offers (with their source) or a status explaining why there are none ("not_checked", "unavailable"). It must never
make numbers up.

None of the Indian quick-commerce or marketplace apps has a public ordering/price API, so today every provider is a
`DeviceProvider`: carts are filled, prices read and order history imported by AURA's agent on the user's own phone,
inside the store's app. A provider with a real API later is just another subclass.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field

from app.ml.shopping_catalog import RESTAURANT_FOOD, canonical_app
from app.services.shopping_browser import STORES

GROCERY = {"dairy", "bakery", "fruits_vegetables", "staples", "beverages", "snacks", "household", "personal_care",
           "baby", "pet", "health", "other"}
KIND_CATEGORIES: dict[str, set[str]] = {
    "quick_commerce": GROCERY,
    "grocery": GROCERY - {"pet"},
    "marketplace": {"staples", "beverages", "household", "personal_care", "baby", "pet", "health", "electronics",
                    "home", "fashion", "books", "other"},
    "fashion": {"fashion"},
    "beauty": {"personal_care"},
    "pharmacy": {"health"},
    "electronics": {"electronics", "home"},
    "food_delivery": {RESTAURANT_FOOD},
}
# what kind of store each known provider is (a fact about the store, not a delivery promise)
KIND = {"blinkit": "quick_commerce", "zepto": "quick_commerce", "instamart": "quick_commerce", "bigbasket": "grocery",
        "jiomart": "grocery", "dmart": "grocery", "amazon": "marketplace", "flipkart": "marketplace",
        "meesho": "marketplace", "myntra": "fashion", "ajio": "fashion", "nykaa": "beauty", "1mg": "pharmacy",
        "pharmeasy": "pharmacy", "croma": "electronics", "zomato": "food_delivery"}
KIND_LABEL = {"quick_commerce": "quick-delivery app", "grocery": "grocery store", "marketplace": "marketplace",
              "fashion": "fashion store", "beauty": "beauty store", "pharmacy": "pharmacy",
              "electronics": "electronics store", "food_delivery": "food-delivery app"}


@dataclass
class Offer:
    """One purchasable option. Every number carries its source; unknown stays None (never guessed)."""
    provider: str
    product: str
    price: float | None = None          # for the requested quantity
    fees: dict[str, float] = field(default_factory=dict)   # delivery, platform, handling... when known
    eta_minutes: int | None = None
    available: bool | None = None
    source: str = "not_checked"         # live_app | your_last_order | web_listing | not_checked
    observed: str | None = None         # when the numbers were seen (ISO date)
    qty: int = 1

    @property
    def final_cost(self) -> float | None:
        return None if self.price is None else round(self.price + sum(self.fees.values()), 2)

    def to_dict(self) -> dict:
        return {**asdict(self), "final_cost": self.final_cost}


@dataclass
class ProviderResult:
    provider: str
    status: str                 # searched | not_checked | unavailable
    offers: list[Offer] = field(default_factory=list)
    detail: str = ""


class ShoppingProvider(ABC):
    key: str
    name: str
    kind: str
    android_package: str | None = None
    # what this integration can really do
    capabilities: dict[str, bool] = {"fill_cart": False, "live_quote": False, "import_history": False}

    def sells(self, category: str) -> bool:
        return category in KIND_CATEGORIES.get(self.kind, set())

    @property
    def label(self) -> str:
        return KIND_LABEL.get(self.kind, "store")

    @abstractmethod
    async def search(self, query: str, qty: int = 1) -> ProviderResult:
        """Real offers for `query`, or a status saying why there are none. Never fabricated."""


class DeviceProvider(ShoppingProvider):
    """A store reached through its own app on the user's phone (AURA's accessibility agent). The server can't see its
    prices by itself: quotes arrive when the phone reads them, so a server-side search honestly reports
    'not_checked'."""

    capabilities = {"fill_cart": True, "live_quote": False, "import_history": True}

    def __init__(self, key: str, spec: dict):
        self.key, self.name = key, spec["name"]
        self.kind = KIND.get(key, "marketplace")
        self.android_package = spec.get("package")

    async def search(self, query: str, qty: int = 1) -> ProviderResult:
        return ProviderResult(self.name, "not_checked",
                              detail="Prices and delivery times are read from the app on your phone; not checked yet.")


class ProviderRegistry:
    def __init__(self) -> None:
        self._providers: dict[str, ShoppingProvider] = {}

    def register(self, provider: ShoppingProvider) -> None:
        self._providers[provider.name] = provider

    def get(self, name: str | None) -> ShoppingProvider | None:
        return self._providers.get(canonical_app(name)) if name else None

    def all(self) -> list[ShoppingProvider]:
        return list(self._providers.values())

    def for_category(self, category: str, installed: set[str] | None = None) -> list[ShoppingProvider]:
        """Providers that sell this kind of product; if the phone told us which apps it has, only those."""
        out = [p for p in self._providers.values() if p.sells(category)]
        if installed:
            have = {canonical_app(i) for i in installed}
            out = [p for p in out if p.name in have] or out
        return out


registry = ProviderRegistry()
for _key, _spec in STORES.items():
    registry.register(DeviceProvider(_key, _spec))
