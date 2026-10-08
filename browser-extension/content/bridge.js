/**
 * Runs only on the AURA web app itself. Bridges the page (which can't call
 * chrome.* APIs directly) to the extension's background worker, and marks
 * the page so AURA's UI knows the extension is installed.
 */

window.postMessage({ source: "aura-extension", type: "AURA_EXTENSION_READY" }, "*");

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || msg.source !== "aura-web" || msg.type !== "AURA_QUICK_CART_START") return;

  chrome.runtime.sendMessage(
    {
      type: "QUICK_CART_START",
      requestId: msg.requestId,
      platform: msg.platform,
      items: msg.items,
      originTabId: null, // filled in by the background worker from sender.tab.id of THIS message
    },
    (response) => {
      window.postMessage({ source: "aura-extension", type: "AURA_QUICK_CART_ACK", requestId: msg.requestId, ok: response?.ok ?? false, error: response?.error }, "*");
    },
  );
});

// Progress/completion messages relayed from background (see notifyOrigin in background.js).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "QUICK_CART_PROGRESS" || msg?.type === "QUICK_CART_DONE") {
    window.postMessage({ source: "aura-extension", ...msg }, "*");
  }
});
