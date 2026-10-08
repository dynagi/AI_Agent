/**
 * Generic "add items to cart" engine, shared by Blinkit/Zepto/Instamart.
 *
 * Deliberately does NOT use hardcoded CSS class names: these are React/Next
 * apps with hashed, build-specific class names that can't be known without
 * live DOM inspection (and would break on the next deploy anyway). Instead
 * it matches on visible text, which is far more stable:
 *   - a product "card" is the smallest ancestor that contains both the
 *     product name we're looking for AND an add-to-cart control
 *   - the add-to-cart control is a clickable element whose text is "ADD"
 *     (the convention on all three of these apps) or whose aria-label
 *     mentions "add"
 *   - quantity beyond 1 is done by clicking the "+" stepper that these
 *     apps show in place of "ADD" once an item is in the cart
 *
 * One item per page load: the background worker hands this script one
 * item, it searches + adds it, reports back, and gets told either the next
 * item (triggering a fresh navigation) or that the job is done. This is
 * slower than a single-page loop but far more robust than trying to drive
 * an in-page search box we don't have real selectors for.
 */

(async function auraAutomateMain() {
  const widget = auraCreateStatusWidget();

  const ready = await chrome.runtime.sendMessage({ type: "AUTOMATE_READY" });
  if (!ready?.ok) return; // this tab has no active AURA job

  widget.show();
  await auraProcessItem(ready.item, ready.index, ready.total, widget);
})();

async function auraProcessItem(item, index, total, widget) {
  widget.update(`Adding ${index + 1}/${total}: ${item.name}…`);

  const result = await auraAddItemToCart(item);
  widget.update(result.ok ? `Added: ${item.name}` : `Couldn't add: ${item.name} — you may need to add it yourself`);

  const next = await chrome.runtime.sendMessage({ type: "ITEM_DONE", ok: result.ok, note: result.note });

  if (next?.done) {
    widget.done();
    return;
  }
  if (next?.item) {
    // Full navigation per item — see file header for why. The content
    // script re-runs on the new page and this whole flow starts over.
    location.href = buildSearchUrl(next.item.name);
  }
}

/** Rebuilds the same search URL the background worker used to open this tab. */
function buildSearchUrl(query) {
  const q = encodeURIComponent(query);
  switch (AURA_SITE_NAME) {
    case "blinkit":
      return `https://blinkit.com/s/?q=${q}`;
    case "zepto":
      return `https://www.zeptonow.com/search?query=${q}`;
    case "instamart":
      return `https://www.swiggy.com/instamart/search?custom_back=true&query=${q}`;
    default:
      return location.href;
  }
}

async function auraAddItemToCart(item) {
  // Give the SPA time to render search results after navigation.
  await auraSleep(1500);

  const card = await auraWaitFor(() => auraFindMatchingCard(item.name), { timeout: 9000, interval: 300 });
  if (!card) {
    return { ok: false, note: "No matching product found on the results page" };
  }

  const addControl = auraFindAddControl(card);
  if (!addControl) {
    return { ok: false, note: "Found the product but no Add control near it" };
  }

  if (!auraSafeClick(addControl)) {
    return { ok: false, note: "Add control looked like a payment/checkout action — refused to click it" };
  }

  const qty = Math.max(1, Number(item.qty) || 1);
  if (qty > 1) {
    await auraSleep(600); // let the "ADD" button morph into a +/- stepper
    for (let i = 1; i < qty; i++) {
      const inc = auraFindIncrementControl(card);
      if (!inc) break; // best-effort: stop rather than risk clicking the wrong thing
      auraSafeClick(inc);
      await auraSleep(400);
    }
  }

  return { ok: true, note: `Requested qty ${qty}` };
}

/** Finds the smallest ancestor of an "ADD" button whose text also matches the product name. */
function auraFindMatchingCard(productName) {
  const addButtons = auraFindAllAddButtons();
  for (const btn of addButtons) {
    let node = btn;
    for (let depth = 0; depth < 6 && node; depth++) {
      const text = node.innerText || node.textContent || "";
      if (text.length > 0 && text.length < 500 && auraFuzzyMatch(text, productName)) {
        return node;
      }
      node = node.parentElement;
    }
  }
  return null;
}

function auraFindAllAddButtons() {
  const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
  return candidates.filter((el) => {
    if (el.children.length > 2) return false; // leaf-ish controls only
    const text = (el.innerText || el.textContent || "").trim();
    const aria = (el.getAttribute("aria-label") || "").trim();
    return /^add$/i.test(text) || /add to cart|add item/i.test(aria);
  });
}

function auraFindAddControl(card) {
  const text = (card.innerText || card.textContent || "");
  if (!/\badd\b/i.test(text)) return null;
  const inCard = Array.from(card.querySelectorAll('button, [role="button"], div, span')).filter((el) => {
    if (el.children.length > 2) return false;
    const t = (el.innerText || el.textContent || "").trim();
    const aria = (el.getAttribute("aria-label") || "").trim();
    return /^add$/i.test(t) || /add to cart|add item/i.test(aria);
  });
  return inCard[0] || null;
}

function auraFindIncrementControl(card) {
  const controls = Array.from(card.querySelectorAll('button, [role="button"], div, span')).filter((el) => {
    if (el.children.length > 0) return false;
    const t = (el.innerText || el.textContent || "").trim();
    const aria = (el.getAttribute("aria-label") || "").trim();
    return t === "+" || /increase quantity|increment/i.test(aria);
  });
  return controls[0] || null;
}

function auraCreateStatusWidget() {
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;bottom:20px;right:20px;z-index:2147483647;background:#0b0f1a;color:#fff;" +
    "font:14px/1.4 system-ui,sans-serif;padding:12px 16px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.35);" +
    "max-width:320px;display:none;";
  el.innerHTML = '<b style="color:#00d1ff">AURA Cart Assistant</b><div id="aura-status-text" style="margin-top:4px"></div>';
  document.documentElement.appendChild(el);
  const textEl = () => el.querySelector("#aura-status-text");

  return {
    show() {
      el.style.display = "block";
    },
    update(msg) {
      const t = textEl();
      if (t) t.textContent = msg;
    },
    done() {
      const t = textEl();
      if (t) t.textContent = "Done — open your cart to review and pay. AURA never completes payment for you.";
      setTimeout(() => el.remove(), 15000);
    },
  };
}
