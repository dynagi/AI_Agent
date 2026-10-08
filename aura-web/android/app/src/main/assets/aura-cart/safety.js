/**
 * Shared safety guard for every site's automation script. The one rule that
 * must never break: AURA fills the cart, a human pays. This is the single
 * choke point every click and navigation goes through to enforce that.
 */

// Anything whose visible text, aria-label, title, or href/URL matches this
// is off-limits, full stop — no click, no programmatic navigation.
const AURA_FORBIDDEN_PATTERN =
  /\b(pay|payment|checkout|place[\s-]?order|confirm[\s-]?order|buy[\s-]?now|complete[\s-]?order|proceed\s+to\s+pay|upi|card\s+number|cvv|otp)\b/i;

function auraIsForbiddenText(text) {
  return !!text && AURA_FORBIDDEN_PATTERN.test(text);
}

function auraElementLooksForbidden(el) {
  if (!el) return false;
  const text = (el.innerText || el.textContent || "").trim();
  const aria = el.getAttribute?.("aria-label") || "";
  const title = el.getAttribute?.("title") || "";
  const href = el.getAttribute?.("href") || "";
  return auraIsForbiddenText(text) || auraIsForbiddenText(aria) || auraIsForbiddenText(title) || auraIsForbiddenText(href);
}

/** The only way automation scripts are allowed to click something. */
function auraSafeClick(el) {
  if (!el) return false;
  if (auraElementLooksForbidden(el)) {
    console.warn("[AURA Cart Assistant] Refused to click a payment/checkout-looking element:", el);
    return false;
  }
  el.click();
  return true;
}

function auraSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function auraWaitFor(check, { timeout = 8000, interval = 200 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = check();
    if (result) return result;
    await auraSleep(interval);
  }
  return null;
}

/** Loose product-name match: every significant word of the query must appear in the candidate text. */
function auraFuzzyMatch(candidateText, query) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  const words = norm(query);
  const hay = norm(candidateText).join(" ");
  if (!words.length) return false;
  return words.every((w) => hay.includes(w));
}
