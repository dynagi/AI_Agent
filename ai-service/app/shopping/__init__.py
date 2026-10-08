"""The Shopping Agent's reasoning core, independent of any one store.

    request -> intent -> preferences (memory) -> providers -> offers -> decision engine -> ask / confirm / execute
                                                                             |
                                                                   policy (what needs the user's yes)

  providers.py    ShoppingProvider interface + registry: which stores exist, what each sells, what each can do
                  (fill a cart on the phone, give a live quote, import history). Adding a store = one entry.
  preferences.py  structured long-term memory built from order history and past decisions: usual product, size,
                  quantity, provider, frequency, typical price, and learnt price-vs-speed weights, each with a
                  confidence. Not raw chat history.
  policy.py       the user's purchase rules (confirm new products / above an amount / price jumps, auto-repeat rules).
  session.py      short-term memory: the current shopping conversation, its options and the pending question, so
                  "Zepto", "the cheaper one" and "yes" mean something.
  engine.py       ranks the options and decides: ask which one, ask to confirm, or go ahead; interprets the answer.

Nothing here invents prices, availability or delivery times. An offer always says where its numbers came from
(read live from the app, the user's own last order, a web listing) and a provider that wasn't checked says so.
"""
