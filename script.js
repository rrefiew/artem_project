const API_CHECK_EMAIL_URL = "http://localhost:8080/api/check";

const toggleBtn = document.getElementById("toggleBtn");
const statusText = document.getElementById("statusText");
const currentSite = document.getElementById("currentSite");
const networkState = document.getElementById("networkState");
const riskBadge = document.getElementById("riskBadge");
const checkCurrentSiteBtn = document.getElementById("checkCurrentSiteBtn");

const evidenceState = document.getElementById("evidenceState");
const networkStats = document.getElementById("networkStats");
const domainsList = document.getElementById("domainsList");
const requestsList = document.getElementById("requestsList");

const verdictState = document.getElementById("verdictState");
const verdictList = document.getElementById("verdictList");

const showEmailBtn = document.getElementById("showEmailBtn");
const emailPanel = document.getElementById("emailPanel");
const emailInput = document.getElementById("emailInput");
const checkEmailBtn = document.getElementById("checkEmailBtn");
const emailResult = document.getElementById("emailResult");

document.addEventListener("DOMContentLoaded", async () => {
  await renderState();
});

toggleBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["enabled"]);
  const newEnabled = !data.enabled;

  if (newEnabled) {
    await chrome.storage.local.set({
      enabled: true
    });

    await startCurrentSiteCollection(false);
    await renderState();
  } else {
    await chrome.storage.local.set({
      enabled: false,
      currentUrl: null,
      lastEvidence: null,
      isCollecting: false
    });

    chrome.runtime.sendMessage({
      type: "RESET_STATE"
    });

    renderDefaultState();
  }
});

checkCurrentSiteBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["enabled"]);

  if (!data.enabled) {
    networkState.textContent = "Сначала включите проверку.";
    return;
  }

  await startCurrentSiteCollection(true);
});

showEmailBtn.addEventListener("click", () => {
  emailPanel.classList.toggle("hidden");
});

checkEmailBtn.addEventListener("click", async () => {
  await checkEmail();
});

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.enabled ||
    changes.currentUrl ||
    changes.lastEvidence ||
    changes.isCollecting
  ) {
    await renderState();
  }
});

async function renderState() {
  const data = await chrome.storage.local.get([
    "enabled",
    "currentUrl",
    "lastEvidence",
    "isCollecting"
  ]);

  const enabled = Boolean(data.enabled);

  renderPowerButton(enabled);

  if (!enabled) {
    renderDefaultState();
    return;
  }

  if (data.currentUrl) {
    currentSite.textContent = getHostname(data.currentUrl);
  } else {
    const tab = await getCurrentTab();
    currentSite.textContent = tab?.url ? getHostname(tab.url) : "Сайт не определен";
  }

  renderEvidence(data.lastEvidence);
  renderNetworkVerdict(data.lastEvidence);
}

function renderDefaultState() {
  renderPowerButton(false);

  currentSite.textContent = "Сайт не определен";

  networkState.textContent = "Данные пока не собраны";
  riskBadge.classList.add("hidden");

  evidenceState.textContent = "Сторонние запросы пока не зафиксированы";
  networkStats.innerHTML = "";
  domainsList.innerHTML = "";
  requestsList.innerHTML = "";

  verdictState.textContent = "Вывод пока не сформирован";
  verdictList.innerHTML = "";

  checkCurrentSiteBtn.disabled = false;
}

function renderPowerButton(enabled) {
  if (enabled) {
    toggleBtn.textContent = "ON";
    toggleBtn.classList.remove("off");
    toggleBtn.classList.add("on");
    statusText.textContent = "Проверка включена";
  } else {
    toggleBtn.textContent = "OFF";
    toggleBtn.classList.remove("on");
    toggleBtn.classList.add("off");
    statusText.textContent = "Проверка выключена";
  }
}

async function startCurrentSiteCollection(reloadPage) {
  const tab = await getCurrentTab();

  if (!tab || !tab.url || !tab.url.startsWith("http")) {
    networkState.textContent = "Откройте обычный сайт для проверки.";
    return;
  }

  currentSite.textContent = getHostname(tab.url);
  networkState.textContent = "Сбор данных запущен...";
  checkCurrentSiteBtn.disabled = true;

  chrome.runtime.sendMessage(
    {
      type: "START_CURRENT_SITE",
      tabId: tab.id,
      url: tab.url
    },
    async (response) => {
      checkCurrentSiteBtn.disabled = false;

      if (chrome.runtime.lastError) {
        networkState.textContent = "Ошибка связи с background.js";
        return;
      }

      if (!response || !response.success) {
        networkState.textContent = "Не удалось запустить сбор данных";
        return;
      }

      if (reloadPage) {
        await chrome.tabs.reload(tab.id);
      }

      await renderState();
    }
  );
}

function renderEvidence(evidence) {
  networkStats.innerHTML = "";
  domainsList.innerHTML = "";
  requestsList.innerHTML = "";

  if (!evidence) {
    evidenceState.textContent = "Сторонние запросы пока не зафиксированы";
    networkState.textContent = "Данные пока не собраны";
    riskBadge.classList.add("hidden");
    return;
  }

  if (evidence.note) {
    evidenceState.textContent = evidence.note;
    networkState.textContent = "Ожидается загрузка страницы";
    riskBadge.className = "risk-badge risk-unknown";
    riskBadge.textContent = "Ожидание";
    riskBadge.classList.remove("hidden");
    return;
  }

  const total = evidence.thirdPartyRequestCount || 0;

  if (total === 0) {
    evidenceState.textContent = "Сторонние запросы не обнаружены";
  } else {
    evidenceState.textContent = `Обнаружено сторонних запросов: ${total}`;
  }

  renderNetworkStats(evidence.categoryCounts);
  renderDomains(evidence.thirdPartyDomains);
  renderRequests(evidence.requests);
}

function renderNetworkStats(categoryCounts) {
  const counts = categoryCounts || {};

  const stats = [
    {
      label: "Аналитика",
      value: counts.analytics || 0
    },
    {
      label: "Реклама",
      value: counts.ads || 0
    },
    {
      label: "Трекинг",
      value: counts.tracking || 0
    },
    {
      label: "Прочее",
      value: counts.other || 0
    }
  ];

  for (const item of stats) {
    const div = document.createElement("div");
    div.className = "network-stat-item";
    div.innerHTML = `
      <span>${item.label}</span>
      <strong>${item.value}</strong>
    `;
    networkStats.appendChild(div);
  }
}

function renderDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0) {
    return;
  }

  const title = document.createElement("div");
  title.className = "small-title";
  title.textContent = "Сторонние домены";
  domainsList.appendChild(title);

  for (const domain of domains.slice(0, 8)) {
    const div = document.createElement("div");
    div.className = "domain-item";

    const categories = Object.keys(domain.categories || {}).join(", ");

    div.innerHTML = `
      <div>
        <strong>${escapeHtml(domain.domain)}</strong>
        <span>${escapeHtml(categories || "other")}</span>
      </div>
      <b>${domain.count}</b>
    `;

    domainsList.appendChild(div);
  }
}

function renderRequests(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return;
  }

  const title = document.createElement("div");
  title.className = "small-title";
  title.textContent = "Примеры запросов";
  requestsList.appendChild(title);

  for (const request of requests.slice(-5).reverse()) {
    const div = document.createElement("div");
    div.className = "request-item";

    div.innerHTML = `
      <div class="request-main">
        ${escapeHtml(request.label || request.category || "third-party request")}
      </div>
      <div class="request-meta">
        ${escapeHtml(request.domain)} · ${escapeHtml(request.type)}
      </div>
      <div class="request-url">
        ${escapeHtml(request.url)}
      </div>
    `;

    requestsList.appendChild(div);
  }
}

function renderNetworkVerdict(evidence) {
  verdictList.innerHTML = "";

  if (!evidence) {
    verdictState.textContent = "Вывод пока не сформирован";
    return;
  }

  if (evidence.note) {
    verdictState.textContent = "Недостаточно данных";
    addVerdictItem(
      "neutral",
      "Ожидается сбор данных",
      "Обновите страницу при включенном расширении, чтобы зафиксировать сетевые запросы с начала загрузки."
    );
    return;
  }

  const counts = evidence.categoryCounts || {};
  const total = evidence.thirdPartyRequestCount || 0;

  const analytics = counts.analytics || 0;
  const ads = counts.ads || 0;
  const tracking = counts.tracking || 0;
  const other = counts.other || 0;

  let riskLevel = calculateNetworkRisk({
  total,
  analytics,
  ads,
  tracking,
  other
});

  riskBadge.className = `risk-badge ${getRiskClass(riskLevel)}`;
  riskBadge.textContent = getRiskText(riskLevel);
  riskBadge.classList.remove("hidden");

  networkState.textContent = "Сетевой анализ выполнен";

  if (riskLevel === "low") {
  verdictState.textContent = "Критичных признаков не найдено";

  if (total === 0) {
    addVerdictItem(
      "good",
      "Сторонние запросы не обнаружены",
      "Во время проверки расширение не зафиксировало обращений к сторонним доменам."
    );
  } else if (ads > 0 && analytics === 0 && tracking === 0) {
    addVerdictItem(
      "good",
      "Обнаружена только реклама",
      "Сайт загружает рекламные домены, но явных признаков трекинга или аналитики не найдено."
    );
  } else {
    addVerdictItem(
      "good",
      "Низкий сетевой риск",
      "Критичных сетевых признаков не обнаружено."
    );
  }

  return;
}

  if (riskLevel === "medium") {
  verdictState.textContent = "Есть признаки сбора технических данных";

  if (analytics > 0) {
    addVerdictItem(
      "warning",
      "Обнаружена аналитика",
      "Сайт загружает сторонние аналитические сервисы. Они могут использоваться для анализа поведения пользователя."
    );
  }

  if (ads > 0) {
    addVerdictItem(
      "neutral",
      "Дополнительно обнаружена реклама",
      "Рекламные запросы сами по себе не считаются высоким риском, но учитываются как часть сетевого поведения сайта."
    );
  }

  if (other > 0) {
    addVerdictItem(
      "neutral",
      "Обнаружены прочие сторонние домены",
      "Сайт выполняет запросы к сторонним доменам, назначение которых не классифицировано."
    );
  }

  return;
}

  if (riskLevel === "high") {
  verdictState.textContent = "Обнаружены признаки повышенного риска";

  if (tracking > 0) {
    addVerdictItem(
      "danger",
      "Обнаружены признаки трекинга",
      "Сайт обращается к доменам или URL, похожим на трекинговые сервисы."
    );
  }

  if (ads > 0) {
    addVerdictItem(
      "warning",
      "Дополнительно обнаружена реклама",
      "Рекламные запросы обнаружены вместе с признаками трекинга, поэтому они усиливают общий риск."
    );
  }

  if (analytics > 0) {
    addVerdictItem(
      "warning",
      "Дополнительно обнаружена аналитика",
      "Помимо трекинга сайт также загружает аналитические сервисы."
    );
  }
}
}

function calculateNetworkRisk(stats) {
  const total = stats.total || 0;
  const analytics = stats.analytics || 0;
  const ads = stats.ads || 0;
  const tracking = stats.tracking || 0;
  const other = stats.other || 0;

  if (total === 0) {
    return "low";
  }

  // Явный трекинг считаем самым серьезным признаком.
  if (tracking > 0) {
    return "high";
  }

  // Только реклама без трекинга и аналитики — низкий риск.
  // Это не идеально, но для пользовательского интерфейса адекватнее,
  // потому что реклама встречается почти на каждом сайте.
  if (ads > 0 && analytics === 0 && other === 0) {
    return "low";
  }

  // Аналитика — средний риск, потому что она обычно собирает поведение пользователя.
  if (analytics > 0) {
    return "medium";
  }

  // Прочие сторонние домены — средний риск, потому что назначение неясно.
  if (other > 0) {
    return "medium";
  }

  return "low";
}

function addVerdictItem(level, title, text) {
  const div = document.createElement("div");
  div.className = `comparison-item comparison-${level}`;

  const titleDiv = document.createElement("div");
  titleDiv.className = "comparison-title";
  titleDiv.textContent = title;

  const textDiv = document.createElement("div");
  textDiv.className = "comparison-text";
  textDiv.textContent = text;

  div.appendChild(titleDiv);
  div.appendChild(textDiv);

  verdictList.appendChild(div);
}

async function checkEmail() {
  const email = emailInput.value.trim();

  if (!email) {
    emailResult.className = "email-result error";
    emailResult.textContent = "Введите email.";
    return;
  }

   if (!isValidEmail(email)) {
    emailResult.className = "email-result error";
    emailResult.textContent = "Введите корректный email.";
    return;
  }

  checkEmailBtn.disabled = true;
  emailResult.className = "email-result";
  emailResult.textContent = "Проверяю email...";

  try {
    const response = await fetch(API_CHECK_EMAIL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email })
    });

    if (!response.ok) {
  const errorText = await response.text();

  if (response.status === 502) {
    throw new Error("Сервис проверки временно недоступен. Попробуйте позже.");
  }

  throw new Error(errorText || `Ошибка сервера: ${response.status}`);
}

    const result = await response.json();

    const isLeaked = Boolean(result.is_leaked) || Number(result.found || 0) > 0;

    if (isLeaked) {
    emailResult.className = "email-result warning";
    emailResult.innerHTML = renderEmailLeakResult(result);
    } else {
    emailResult.className = "email-result success";
    emailResult.textContent = "Утечки для этого email не найдены.";
    }
  } catch (error) {
    emailResult.className = "email-result error";
    emailResult.textContent = `Ошибка проверки: ${error.message}`;
  } finally {
    checkEmailBtn.disabled = false;
  }
}

function renderEmailLeakResult(result) {
  const found = Number(result.found || 0);

  const fields = Array.isArray(result.fields) && result.fields.length > 0
    ? result.fields.map(escapeHtml).join(", ")
    : "нет данных";

  return `
    <div class="email-leak-summary">
      <strong>Найдены утечки: ${found}</strong>
    </div>

    <div class="email-leak-fields">
      <strong>Что утекло:</strong><br>
      ${fields}
    </div>

    ${renderEmailSources(result.sources)}
  `;
}

function renderEmailSources(sources) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return `
      <div class="email-leak-sources">
        <strong>Где найдено:</strong><br>
        Источники не пришли в ответе API.
      </div>
    `;
  }

  const items = sources.map((source) => {
    const name = escapeHtml(source.name || "Неизвестный источник");
    const date = escapeHtml(source.date || "дата неизвестна");

    return `
      <div class="email-source-item">
        <div class="email-source-name">${name}</div>
        <div class="email-source-meta">Дата: ${date}</div>
      </div>
    `;
  }).join("");

  return `
    <div class="email-leak-sources">
      <strong>Где найдено:</strong>
      ${items}
    </div>
  `;
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0];
}

function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getRiskClass(riskLevel) {
  switch (riskLevel) {
    case "low":
      return "risk-low";
    case "medium":
      return "risk-medium";
    case "high":
      return "risk-high";
    default:
      return "risk-unknown";
  }
}

function getRiskText(riskLevel) {
  switch (riskLevel) {
    case "low":
      return "Низкий риск";
    case "medium":
      return "Средний риск";
    case "high":
      return "Высокий риск";
    default:
      return "Неизвестно";
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}