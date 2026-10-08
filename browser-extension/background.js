/**
 * AURA Cart Assistant — background service worker.
 *
 * Owns the shopping-list "job" for each tab it opens. Never touches
 * credentials, payment, or checkout — its only job is: open the platform,
 * hand the item list to the content script running there, and relay
 * progress back to the AURA tab that started it.
 */

// jobsByTabId: tabId -> { requestId, platform, items: [{name, qty}], cursor, originTabId }
const jobsByTabId = new Map();

const SEARCH_URL = {
  blinkit: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}`,
  zepto: (q) => `https://www.zeptonow.com/search?query=${encodeURIComponent(q)}`,
  instamart: (q) => `https://www.swiggy.com/instamart/search?custom_back=true&query=${encodeURIComponent(q)}`,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "QUICK_CART_START": {
      const { requestId, platform, items } = msg;
      const originTabId = sender.tab?.id ?? null;
      if (!SEARCH_URL[platform] || !Array.isArray(items) || items.length === 0) {
        sendResponse({ ok: false, error: "Invalid platform or empty item list" });
        return true;
      }
      chrome.tabs.create({ url: SEARCH_URL[platform](items[0].name) }, (tab) => {
        jobsByTabId.set(tab.id, { requestId, platform, items, cursor: 0, originTabId });
      });
      sendResponse({ ok: true });
      return true;
    }

    case "AUTOMATE_READY": {
      const tabId = sender.tab?.id;
      const job = tabId != null ? jobsByTabId.get(tabId) : null;
      if (!job) {
        sendResponse({ ok: false });
        return true;
      }
      sendResponse({
        ok: true,
        item: job.items[job.cursor],
        index: job.cursor,
        total: job.items.length,
      });
      return true;
    }

    case "ITEM_DONE": {
      const tabId = sender.tab?.id;
      const job = tabId != null ? jobsByTabId.get(tabId) : null;
      if (!job) return true;

      notifyOrigin(job, { type: "QUICK_CART_PROGRESS", requestId: job.requestId, index: job.cursor, total: job.items.length, ok: msg.ok, note: msg.note });

      job.cursor += 1;
      if (job.cursor >= job.items.length) {
        notifyOrigin(job, { type: "QUICK_CART_DONE", requestId: job.requestId, platform: job.platform });
        jobsByTabId.delete(tabId);
        sendResponse({ done: true });
      } else {
        sendResponse({ done: false, item: job.items[job.cursor], index: job.cursor, total: job.items.length });
      }
      return true;
    }

    default:
      return false;
  }
});

function notifyOrigin(job, message) {
  if (job.originTabId == null) return;
  chrome.tabs.sendMessage(job.originTabId, message).catch(() => {
    /* AURA tab may have been closed — nothing to relay progress to. */
  });
}

chrome.tabs.onRemoved.addListener((tabId) => jobsByTabId.delete(tabId));
