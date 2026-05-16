const MAX_STORED_REQUESTS = 50;

const tabEvidence = new Map();

const KNOWN_THIRD_PARTY_PATTERNS = [
  {
    pattern: "google-analytics.com",
    category: "analytics",
    label: "Google Analytics"
  },
  {
    pattern: "googletagmanager.com",
    category: "analytics",
    label: "Google Tag Manager"
  },
  {
    pattern: "doubleclick.net",
    category: "ads",
    label: "DoubleClick advertising"
  },
  {
    pattern: "googleadservices.com",
    category: "ads",
    label: "Google Ads"
  },
  {
    pattern: "facebook.net",
    category: "tracking",
    label: "Meta/Facebook tracking"
  },
  {
    pattern: "facebook.com/tr",
    category: "tracking",
    label: "Meta Pixel"
  },
  {
    pattern: "connect.facebook.net",
    category: "tracking",
    label: "Meta/Facebook tracking"
  },
  {
    pattern: "hotjar.com",
    category: "analytics",
    label: "Hotjar analytics"
  },
  {
    pattern: "clarity.ms",
    category: "analytics",
    label: "Microsoft Clarity"
  },
  {
    pattern: "mc.yandex.ru",
    category: "analytics",
    label: "Yandex Metrica"
  },
  {
    pattern: "metrika",
    category: "analytics",
    label: "Analytics service"
  },
  {
    pattern: "adservice",
    category: "ads",
    label: "Advertising service"
  },
  {
    pattern: "ads",
    category: "ads",
    label: "Possible advertising service"
  },
  {
    pattern: "track",
    category: "tracking",
    label: "Possible tracking service"
  },
  {
    pattern: "tracker",
    category: "tracking",
    label: "Possible tracking service"
  },
  {
    pattern: "pixel",
    category: "tracking",
    label: "Possible tracking pixel"
  }
];

chrome.runtime.onInstalled.addListener(async () => {
  tabEvidence.clear();

  await chrome.storage.local.set({
    enabled: false,
    currentUrl: null,
    lastEvidence: null,
    isCollecting: false
  });
});

initializeDefaultState();

async function initializeDefaultState() {
  const data = await chrome.storage.local.get(["enabled"]);

  if (typeof data.enabled === "undefined") {
    await chrome.storage.local.set({
      enabled: false,
      currentUrl: null,
      lastEvidence: null,
      isCollecting: false
    });
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabEvidence.delete(tabId);
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const data = await chrome.storage.local.get(["enabled"]);

  if (!data.enabled) {
    return;
  }

  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);

    if (!tab || !tab.url || !tab.url.startsWith("http")) {
      return;
    }

    if (!tabEvidence.has(activeInfo.tabId)) {
      startEvidenceForTab(activeInfo.tabId, tab.url);
    }

    await saveEvidenceSnapshot(activeInfo.tabId);
  } catch (error) {
    console.warn("Could not update active tab evidence:", error);
  }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    handleWebRequest(details);
  },
  {
    urls: ["<all_urls>"]
  }
);

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") {
    return;
  }

  if (!tab.url || !tab.url.startsWith("http")) {
    return;
  }

  const data = await chrome.storage.local.get(["enabled"]);

  if (!data.enabled) {
    return;
  }

  if (!tabEvidence.has(tabId)) {
    startEvidenceForTab(tabId, tab.url);
    await saveEvidenceSnapshot(tabId);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_CURRENT_SITE") {
    startEvidenceForTab(message.tabId, message.url);

    chrome.storage.local.set({
      currentUrl: message.url,
      lastEvidence: buildEvidenceSnapshot(message.tabId, message.url),
      isCollecting: true
    }).then(() => {
      sendResponse({ success: true });
    });

    return true;
  }

  if (message.type === "RESET_STATE") {
    tabEvidence.clear();

    chrome.storage.local.set({
      currentUrl: null,
      lastEvidence: null,
      isCollecting: false
    }).then(() => {
      sendResponse({ success: true });
    });

    return true;
  }
});

async function handleWebRequest(details) {
  const data = await chrome.storage.local.get(["enabled"]);

  if (!data.enabled) {
    return;
  }

  if (details.tabId < 0) {
    return;
  }

  if (!details.url || !details.url.startsWith("http")) {
    return;
  }

  if (details.type === "main_frame") {
    startEvidenceForTab(details.tabId, details.url);
    await saveEvidenceSnapshot(details.tabId);
    return;
  }

  recordSubRequest(details);
  await saveEvidenceSnapshot(details.tabId);
}

function startEvidenceForTab(tabId, pageUrl) {
  const mainHost = getHostname(pageUrl);

  tabEvidence.set(tabId, {
    pageUrl,
    mainHost,
    startedAt: new Date().toISOString(),
    thirdPartyRequestCount: 0,
    thirdPartyDomains: {},
    categoryCounts: {
      analytics: 0,
      ads: 0,
      tracking: 0,
      other: 0
    },
    requests: []
  });
}

function recordSubRequest(details) {
  const evidence = tabEvidence.get(details.tabId);

  if (!evidence) {
    return;
  }

  const requestHost = getHostname(details.url);

  if (!requestHost) {
    return;
  }

  if (isSameSite(requestHost, evidence.mainHost)) {
    return;
  }

  const classification = classifyRequest(details.url, requestHost);

  evidence.thirdPartyRequestCount += 1;

  if (!evidence.thirdPartyDomains[requestHost]) {
    evidence.thirdPartyDomains[requestHost] = {
      domain: requestHost,
      count: 0,
      types: {},
      categories: {}
    };
  }

  evidence.thirdPartyDomains[requestHost].count += 1;

  evidence.thirdPartyDomains[requestHost].types[details.type] =
    (evidence.thirdPartyDomains[requestHost].types[details.type] || 0) + 1;

  evidence.thirdPartyDomains[requestHost].categories[classification.category] =
    (evidence.thirdPartyDomains[requestHost].categories[classification.category] || 0) + 1;

  evidence.categoryCounts[classification.category] =
    (evidence.categoryCounts[classification.category] || 0) + 1;

  evidence.requests.push({
    domain: requestHost,
    type: details.type,
    category: classification.category,
    label: classification.label,
    url: sanitizeUrl(details.url),
    time: new Date().toISOString()
  });

  if (evidence.requests.length > MAX_STORED_REQUESTS) {
    evidence.requests.shift();
  }
}

async function saveEvidenceSnapshot(tabId) {
  const evidence = buildEvidenceSnapshot(tabId);

  if (!evidence) {
    return;
  }
//
  await chrome.storage.local.set({
    currentUrl: evidence.pageUrl,
    lastEvidence: evidence,
    isCollecting: true
  });
}

function buildEvidenceSnapshot(tabId, fallbackUrl = null) {
  const evidence = tabEvidence.get(tabId);

  if (!evidence) {
    if (!fallbackUrl) {
      return null;
    }

    return {
      pageUrl: fallbackUrl,
      mainHost: getHostname(fallbackUrl),
      checkedAt: new Date().toISOString(),
      thirdPartyRequestCount: 0,
      thirdPartyDomains: [],
      categoryCounts: {
        analytics: 0,
        ads: 0,
        tracking: 0,
        other: 0
      },
      requests: [],
      note: "Данные пока не собраны. Обновите страницу при включенном расширении."
    };
  }

  const domains = Object.values(evidence.thirdPartyDomains)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  return {
    pageUrl: evidence.pageUrl,
    mainHost: evidence.mainHost,
    checkedAt: new Date().toISOString(),
    thirdPartyRequestCount: evidence.thirdPartyRequestCount,
    thirdPartyDomains: domains,
    categoryCounts: evidence.categoryCounts,
    requests: evidence.requests.slice(-15)
  };
}

function classifyRequest(url, host) {
  const lowerUrl = url.toLowerCase();
  const lowerHost = host.toLowerCase();

  for (const item of KNOWN_THIRD_PARTY_PATTERNS) {
    if (lowerUrl.includes(item.pattern) || lowerHost.includes(item.pattern)) {
      return {
        category: item.category,
        label: item.label
      };
    }
  }

  return {
    category: "other",
    label: "Third-party request"
  };
}

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);

    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isSameSite(requestHost, mainHost) {
  if (!requestHost || !mainHost) {
    return true;
  }

  if (requestHost === mainHost) {
    return true;
  }

  if (requestHost.endsWith(`.${mainHost}`)) {
    return true;
  }

  return false;
}