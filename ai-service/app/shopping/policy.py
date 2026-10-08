"""The user's purchase rules: what AURA may do by itself and what always needs a yes.

Shopping spends real money, so the default is cautious: confirm new products, confirm above an amount, confirm when
the price has jumped, and no automatic repeat orders. The user can loosen it, including explicit auto-order rules
("my usual milk from Zepto, up to ₹75, 2 packs"), and AURA never acts outside what is configured here.
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class AutoOrderRule(BaseModel):
    """A repeat purchase the user has pre-approved."""
    item: str                                  # e.g. "milk"
    provider: str | None = None                # only from this store (None = their usual)
    max_price: float | None = Field(None, ge=0)  # per unit; the order needs a confirmation above this
    max_qty: int = Field(5, ge=1, le=50)


class ShoppingPolicy(BaseModel):
    require_confirmation_for_new_product: bool = True
    require_confirmation_above: float = Field(1000, ge=0, description="Order total (INR) that always needs a yes")
    max_price_deviation_percent: float = Field(10, ge=0, description="Confirm when the price is this far above usual")
    allow_auto_repeat_orders: bool = False
    auto_order_rules: list[AutoOrderRule] = Field(default_factory=list)
    # below this confidence in the user's usual store, ask which store instead of assuming
    min_provider_confidence: float = Field(0.55, ge=0, le=1)


def confirmation_reasons(policy: ShoppingPolicy, *, known: bool, total: float | None, unit_price: float | None,
                         typical_price: float | None) -> list[str]:
    """Why this order needs the user's explicit yes (empty = policy doesn't require one)."""
    reasons = []
    if policy.require_confirmation_for_new_product and not known:
        reasons.append("it's a product you haven't bought through AURA before")
    if total is not None and total > policy.require_confirmation_above:
        reasons.append(f"the total (₹{total:,.0f}) is above your ₹{policy.require_confirmation_above:,.0f} limit")
    if unit_price and typical_price and unit_price > typical_price * (1 + policy.max_price_deviation_percent / 100):
        reasons.append(f"the price (₹{unit_price:,.0f}) is more than {policy.max_price_deviation_percent:g}% above "
                       f"what you usually pay (₹{typical_price:,.0f})")
    return reasons


def auto_rule(policy: ShoppingPolicy, *, item: str, provider: str, qty: int, unit_price: float | None,
              known: bool) -> AutoOrderRule | None:
    """The pre-approved rule that covers this order, if any. Without a known price the rule's price cap can't be
    verified, so it doesn't apply."""
    if not policy.allow_auto_repeat_orders or not known:
        return None
    for rule in policy.auto_order_rules:
        if rule.item.lower() != item.lower() or qty > rule.max_qty:
            continue
        if rule.provider and rule.provider.lower() != provider.lower():
            continue
        if rule.max_price is not None and (unit_price is None or unit_price > rule.max_price):
            continue
        return rule
    return None
