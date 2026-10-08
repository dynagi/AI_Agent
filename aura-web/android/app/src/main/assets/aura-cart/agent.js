/**
 * In-page half of the AURA cart agent (the other halves: CartAssistantActivity.java on the phone and
 * ai-service/app/services/shopping_browser.py on the server).
 *
 * Loop: snapshot the page (visible buttons/links/inputs, each tagged with data-aura-id, plus the product
 * card text around them) -> AuraNative.requestStep(snapshot) -> the native side asks the server for the
 * next action -> window.__auraApply(action) executes it -> snapshot again. Full page loads re-inject
 * this script and the loop continues from the new page.
 *
 * Every click goes through auraSafeClick() (safety.js), which refuses anything that looks like payment
 * or checkout; the native WebView also blocks payment-looking URLs.
 */
(function auraAgent() {
  if (window.__auraAgentLoaded) return;
  window.__auraAgentLoaded = true;
  const nonce = Math.random().toString(36).slice(2);
  let busy = false;
  let unloading = false;
  window.addEventListener("pagehide", () => { unloading = true; });

  const widget = createWidget();

  const SHORT_CONTROL = /^(add|add to cart|add to bag|add to basket|add item|\+|−|-|view cart|go to cart|cart|close|×|✕|x|skip|not now|later|continue|ok|got it|select|done|apply)$/i;
  const SELECTOR = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], ' +
    '[role="checkbox"], [role="radio"], [role="menuitem"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"])';

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -100 || r.top > window.innerHeight * 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) > 0.05;
  }

  function clean(s, n) {
    return (s || "").replace(/\s+/g, " ").trim().slice(0, n);
  }

  function cardContext(el, text) {
    let node = el.parentElement;
    for (let d = 0; d < 7 && node; d++, node = node.parentElement) {
      const t = clean(node.innerText, 400);
      if (t.length > text.length + 15) return t.slice(0, 240);
    }
    return null;
  }

  function snapshot() {
    document.querySelectorAll("[data-aura-id]").forEach((e) => e.removeAttribute("data-aura-id"));
    const set = new Set(document.querySelectorAll(SELECTOR));
    document.querySelectorAll("div, span").forEach((el) => {
      if (el.children.length <= 2 && SHORT_CONTROL.test(clean(el.innerText, 30))) set.add(el);
    });
    const ordered = Array.from(set).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    const inView = [];
    const below = [];
    for (const el of ordered) {
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      (r.top < window.innerHeight * 1.5 ? inView : below).push(el);
    }
    const out = [];
    for (const el of inView.concat(below)) {
      if (out.length >= 180) break;
      const tag = el.tagName.toLowerCase();
      const isField = tag === "input" || tag === "select" || tag === "textarea";
      const text = isField ? "" : clean(el.innerText || el.textContent, 100);
      const label = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") ||
        el.getAttribute("alt") || el.querySelector?.("img[alt]")?.getAttribute("alt") || el.getAttribute("name"), 80);
      if (!text && !label && !isField) continue;
      if (tag === "input" && ["hidden"].includes(el.type)) continue;
      const id = "e" + out.length;
      el.setAttribute("data-aura-id", id);
      out.push({
        id, tag,
        role: el.getAttribute("role"),
        text,
        label: label || null,
        href: el.getAttribute("href") ? String(el.href).slice(0, 200) : null,
        type: el.getAttribute("type"),
        value: tag === "input" && el.type !== "password" ? clean(el.value, 60) || null : null,
        context: isField ? null : cardContext(el, text),
        disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      });
    }
    return out;
  }

  async function step() {
    if (busy || unloading) return;
    busy = true;
    await sleep(1400); // let SPA content render
    if (unloading) return;
    const snap = {
      nonce,
      url: location.href,
      title: document.title,
      elements: snapshot(),
      pageText: clean(document.body ? document.body.innerText : "", 3000),
    };
    window.AuraNative.requestStep(JSON.stringify(snap));
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value); // React/Vue track the native setter, plain assignment is ignored
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function pressEnter(el) {
    for (const type of ["keydown", "keypress", "keyup"]) {
      el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    }
    if (el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit();
    }
  }

  async function apply(a) {
    let result = "ok";
    const el = a.elementId ? document.querySelector(`[data-aura-id="${a.elementId}"]`) : null;
    widget.update(a.reason || a.action);
    switch (a.action) {
      case "navigate":
        record(a, "navigating");
        location.href = a.url;
        return; // the next page load re-injects this script
      case "click": {
        if (!el) { result = "element gone"; break; }
        el.scrollIntoView({ block: "center" });
        await sleep(250);
        const times = Math.max(1, Math.min(a.repeat || 1, 20));
        let clicked = 0;
        for (let i = 0; i < times; i++) {
          if (!auraSafeClick(el)) { result = "refused (payment/checkout-like)"; break; }
          clicked++;
          if (i < times - 1) await sleep(500);
        }
        if (clicked) result = times > 1 ? `clicked ${clicked}x` : "clicked";
        break;
      }
      case "type": {
        if (!el) { result = "element gone"; break; }
        el.scrollIntoView({ block: "center" });
        el.focus();
        setNativeValue(el, a.text || "");
        if (a.submit) { await sleep(300); pressEnter(el); }
        result = a.submit ? "typed + enter" : "typed";
        break;
      }
      case "scroll":
        window.scrollBy(0, window.innerHeight * 0.8);
        result = "scrolled";
        break;
      case "back":
        record(a, "going back");
        history.back();
        await sleep(2500);
        break;
      default:
        await sleep(1200);
        result = "waited";
    }
    record(a, result);
    busy = false;
    setTimeout(step, 900);
  }

  function record(a, result) {
    window.AuraNative.record(JSON.stringify({
      action: a.action, target: a.targetText || a.elementId || a.url || null, result, url: location.href,
      completesItem: !!a.completesItem, itemIndex: a.itemIndex,
    }));
  }

  /** Called by the native side with the server's action. Stale answers for an older page are ignored. */
  window.__auraApply = function (actionJson, forNonce) {
    if (forNonce && forNonce !== nonce) return;
    apply(typeof actionJson === "string" ? JSON.parse(actionJson) : actionJson);
  };
  /** Called by the native side to take another step without acting (after item_done / Continue). */
  window.__auraStep = function (message) {
    if (message) widget.update(message);
    busy = false;
    step();
  };
  window.__auraStatus = function (message) { widget.update(message); };

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function createWidget() {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;left:12px;right:12px;bottom:12px;z-index:2147483647;background:#0b0f1a;" +
      "color:#fff;font:13px/1.4 system-ui,sans-serif;padding:10px 14px;border-radius:10px;" +
      "box-shadow:0 6px 24px rgba(0,0,0,.35);pointer-events:none;opacity:.92";
    box.innerHTML = '<b style="color:#00d1ff">AURA is shopping</b> <span id="aura-agent-status"></span>';
    (document.body || document.documentElement).appendChild(box);
    return { update(msg) { const t = box.querySelector("#aura-agent-status"); if (t) t.textContent = "— " + msg; } };
  }

  step();
})();
