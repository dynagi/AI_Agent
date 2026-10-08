# AURA Cart Assistant (browser extension)

Adds items from an AURA shopping list to your cart on **Blinkit**, **Zepto**,
or **Swiggy Instamart** — automatically. It stops there: it never touches
checkout, payment, UPI, card details, or OTPs. You always open the cart
yourself and pay yourself.

## Why this exists

None of these three apps offer a public API for placing orders. The only
way to genuinely add items to *your* cart on *your* account, without AURA
ever storing your login or session, is to automate your own already-logged-in
browser tab — which is what this extension does. It runs entirely on your
machine; nothing it does passes through AURA's servers.

## How it works

1. In the AURA web app, you build (or ask the AI to build) a shopping list
   and pick a platform.
2. The extension opens that platform in a new tab, already logged in as you
   (because it's your normal browser profile).
3. A content script searches for each item by name and clicks the "ADD"
   control on the matching product card, one item per page load.
4. When every item has been attempted, it stops and shows *"Done — open
   your cart to review and pay."* Nothing further happens automatically.

### Why "one item per page load" instead of one continuous session?

We don't have access to these apps' real DOM (they're JS-rendered and block
scripted fetches), so we can't reliably drive their in-page search box.
Doing a full search-URL navigation per item is slower but far more robust —
it only depends on stable, documented public search URLs
(`blinkit.com/s/?q=`, `zeptonow.com/search?query=`,
`swiggy.com/instamart/search?query=`), not on guessed internal selectors.

### How it finds the "Add" button

Also without live DOM access, product-card class names can't be hardcoded
(they're hashed/build-specific and would break on the next deploy anyway).
Instead, `content/automate.js` matches on **visible text**:

- a candidate "Add" control is any small clickable element whose text is
  exactly `ADD` (the convention on all three apps) or whose `aria-label`
  mentions "add"
- it's confirmed as belonging to the right product if a nearby ancestor
  element's text also contains every word of the item name
- extra quantity is added by clicking the `+` stepper that appears in the
  same spot once the item's been added once

This is a best-effort heuristic. If a platform changes its UI conventions,
matching may fail for some items — the assistant reports which ones it
couldn't add rather than guessing at the wrong control.

### The one hard rule: `content/safety.js`

Every click in every site script goes through `auraSafeClick()`, which
refuses to click anything whose text, aria-label, title, or href matches a
denylist of payment/checkout/order-confirmation language (`pay`,
`checkout`, `place order`, `confirm order`, `buy now`, `upi`, `cvv`, `otp`,
...). This is the actual safety boundary, not a suggestion — treat any
change to `safety.js` as security-sensitive.

## Installing (unpacked — not published to the Chrome Web Store)

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `browser-extension/` folder.
4. Open the AURA web app (`http://localhost:5173` in dev) — the extension
   only activates its bridge there, plus on the three shopping domains.

If you deploy the AURA web app to a real domain, add that origin to the
first `content_scripts` entry's `matches` array in `manifest.json` and
reload the extension.

## Limitations

- Best-effort text matching, not a guaranteed integration — verify your
  cart before paying, every time.
- If a platform requires solving a captcha, shows an interstitial ad, or
  restructures its "Add" control away from these conventions, that item
  will be reported as not-added rather than mishandled.
- Out-of-stock items are skipped (no matching "Add" control is found).
