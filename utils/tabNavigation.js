const PAGE_READY_TIMEOUT_MS = 20000;
const PAGE_READY_POLL_INTERVAL_MS = 300;

export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function ensureContentScriptInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    await delay(100);
  } catch (error) {
    if (error?.message?.includes('Cannot access contents of url')) {
      throw new Error('Cannot access page contents. Please refresh and try again.');
    }
    throw error;
  }
}

export async function sendMessageToTab(tabId, message, options = {}) {
  const { retryOnMissingReceiver = true } = options;

  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const missingReceiver =
      error?.message?.includes('Receiving end does not exist') ||
      error?.message?.includes('The message port closed before a response was received.');

    if (retryOnMissingReceiver && missingReceiver) {
      await ensureContentScriptInjected(tabId);
      return chrome.tabs.sendMessage(tabId, message);
    }

    throw error;
  }
}

export function normalizeUrlForComparison(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return '';
  }

  try {
    const url = new URL(rawUrl);
    let normalizedPath = url.pathname;
    if (normalizedPath.length > 1) {
      normalizedPath = normalizedPath.replace(/\\+/g, '/');
      normalizedPath = normalizedPath.replace(/\/+$/, '');
    }

    return `${url.origin}${normalizedPath}${url.search}${url.hash}`;
  } catch (error) {
    return rawUrl;
  }
}

export function urlsReferToSameDocument(firstUrl, secondUrl) {
  return normalizeUrlForComparison(firstUrl) === normalizeUrlForComparison(secondUrl);
}

export async function waitForPageInteractive(tabId, targetUrl) {
  const normalizedTarget = normalizeUrlForComparison(targetUrl);
  const startTime = Date.now();

  while (Date.now() - startTime < PAGE_READY_TIMEOUT_MS) {
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch (error) {
      if (error && error.message && error.message.includes('No tab with id')) {
        throw error;
      }
      await delay(PAGE_READY_POLL_INTERVAL_MS);
      continue;
    }

    const currentUrl = tab.url || tab.pendingUrl || '';
    const normalizedCurrent = normalizeUrlForComparison(currentUrl);

    if (normalizedCurrent === normalizedTarget) {
      try {
        const response = await sendMessageToTab(tabId, { action: 'ping' });
        if (response && response.ready) {
          return tab;
        }
      } catch (error) {
        // Ignore errors while waiting for the content script to initialize
      }
    }

    await delay(PAGE_READY_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for page readiness: ${targetUrl}`);
}

export async function ensureTabAtUrl(tabId, targetUrl, previousUrl) {
  if (!urlsReferToSameDocument(previousUrl, targetUrl)) {
    await chrome.tabs.update(tabId, { url: targetUrl });
  }

  return waitForPageInteractive(tabId, targetUrl);
}

export async function safelyReturnToUrl(tabId, targetUrl) {
  if (!targetUrl) {
    return null;
  }

  try {
    const currentTab = await chrome.tabs.get(tabId);
    const currentUrl = currentTab.url || currentTab.pendingUrl || '';
    return await ensureTabAtUrl(tabId, targetUrl, currentUrl);
  } catch (error) {
    console.error('Failed to return to original page', error);
    return null;
  }
}
