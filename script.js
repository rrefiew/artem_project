// адреса апи для бэка
const API_CHECK_EMAIL_URL = "http://localhost:8080/api/check";
const API_REGISTER_URL = "http://localhost:8080/api/register";
const API_LOGIN_URL = "http://localhost:8080/api/login";
const API_ME_URL = "http://localhost:8080/api/me";
const API_SUBSCRIBE_URL = "http://localhost:8080/api/subscribe";

// основные элементы управления
const toggleBtn = document.getElementById("toggleBtn");
const logoutBtn = document.getElementById("logoutBtn");
const statusText = document.getElementById("statusText");
const currentSite = document.getElementById("currentSite");
const networkState = document.getElementById("networkState");
const riskBadge = document.getElementById("riskBadge");
const checkCurrentSiteBtn = document.getElementById("checkCurrentSiteBtn");

const evidenceState = document.getElementById("evidenceState");
const networkStats = document.getElementById("networkStats");
const domainsList = document.getElementById("domainsList");
const requestsList = document.getElementById("requestsList");

// блок вывода
const verdictState = document.getElementById("verdictState");
const verdictList = document.getElementById("verdictList");

// блок проверки email
const showEmailBtn = document.getElementById("showEmailBtn");
const emailPanel = document.getElementById("emailPanel");
const emailInput = document.getElementById("emailInput");
const checkEmailBtn = document.getElementById("checkEmailBtn");
const emailResult = document.getElementById("emailResult");

// кнопка premium
const premiumBtn = document.getElementById("premiumBtn");

// карточки
const evidenceCard = document.getElementById("evidenceCard");
const verdictCard = document.getElementById("verdictCard");
const premiumLockCard = document.getElementById("premiumLockCard");

// начальная загрузка
document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get(["enabled"]);

  // если состояние еще не задано, расширение выключено
  if (typeof data.enabled === "undefined") {
    await chrome.storage.local.set({
      enabled: false,
      currentUrl: null,
      lastEvidence: null,
      isCollecting: false
    });
  }

  await renderState();

  // периодически обновляем состояние, чтобы premium мог закончиться сам
  setInterval(async () => {
    await renderState();
  }, 2000);
});

// включение и выключение проверки
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

// ручная проверка текущего сайта
checkCurrentSiteBtn.addEventListener("click", async () => {
  const data = await chrome.storage.local.get(["enabled"]);

  if (!data.enabled) {
    networkState.textContent = "Сначала включите проверку.";
    return;
  }

  await startCurrentSiteCollection(true);
});

// показать или скрыть форму email
showEmailBtn.addEventListener("click", () => {
  emailPanel.classList.toggle("hidden");
});

// проверка email на утечки
checkEmailBtn.addEventListener("click", async () => {
  await checkEmail();
});

// premium: если не вошли, открываем отдельную страницу входа
premiumBtn.addEventListener("click", async () => {
  const user = await getAuthUser();

  if (!user) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("auth.html")
    });
    return;
  }

  if (isPremiumUser(user)) {
    premiumBtn.textContent = "Premium";
    premiumBtn.classList.add("premium-active");
    networkState.textContent = "Premium уже активен.";
    return;
  }

  await activatePremium();
});

// если в бд что-то изменилось, обновляем расширение
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (
    changes.enabled ||
    changes.currentUrl ||
    changes.lastEvidence ||
    changes.isCollecting ||
    changes.authToken ||
    changes.authUser
  ) {
    await renderState();
  }
});

// отрисовка текущего состояния расш
async function renderState() {
  const data = await chrome.storage.local.get([
    "enabled",
    "currentUrl",
    "lastEvidence",
    "isCollecting"
  ]);

  const user = await getAuthUser();
  const enabled = Boolean(data.enabled);

  renderAuthState(user);
  renderPowerButton(enabled);
  renderPremiumAccess(user);

  if (!enabled) {
    renderDefaultState();
    renderAuthState(user);
    renderPremiumAccess(user);
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

  renderAuthState(user);
  renderPremiumAccess(user);
}

// дефолтное состояние, когда проверка выключена
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

// меняем вид большой кнопки
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

// запускаем сбор данных по текущей вкладке
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

// показываем подробные сетевые данные
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

// рисуем счетчики по категориям
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

// рисуем список сторонних доменов
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

// рисуем примеры запросов
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

// общий вывод по сетевому поведению
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

// считаем уровень риска по категориям
function calculateNetworkRisk(stats) {
  const total = stats.total || 0;
  const analytics = stats.analytics || 0;
  const ads = stats.ads || 0;
  const tracking = stats.tracking || 0;
  const other = stats.other || 0;

  if (total === 0) {
    return "low";
  }

  // явный трекинг считаем самым серьезным признаком
  if (tracking > 0) {
    return "high";
  }

  // только реклама без аналитики и трекинга - низкий риск
  if (ads > 0 && analytics === 0 && other === 0) {
    return "low";
  }

  // аналитика - средний риск
  if (analytics > 0) {
    return "medium";
  }

  // прочие сторонние домены - средний риск
  if (other > 0) {
    return "medium";
  }

  return "low";
}

// добавляем карточку вывода
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

// проверка email
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

//результат проверки email
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

//источники утечек
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

//получаем активную вкладку
async function getCurrentTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  return tabs[0];
}

//достаем домен из url
function getHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

//css-класс риска
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

// текст риска
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

// экранируем html
function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

//проверка email
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// получаем текущего пользователя
async function getAuthUser() {
  const data = await chrome.storage.local.get(["authToken", "authUser"]);

  if (!data.authToken) {
    return null;
  }

  try {
    const response = await fetch(API_ME_URL, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${data.authToken}`
      }
    });

    if (!response.ok) {
      await chrome.storage.local.remove(["authToken", "authUser"]);

      await chrome.storage.local.set({
        enabled: false,
        currentUrl: null,
        lastEvidence: null,
        isCollecting: false
      });

      chrome.runtime.sendMessage({
        type: "RESET_STATE"
      });

      return null;
    }

    const result = await response.json();

    await chrome.storage.local.set({
      authUser: result.user
    });

    return result.user;
  } catch {
    return data.authUser || null;
  }
}

// оформление premium
async function activatePremium() {
  const data = await chrome.storage.local.get(["authToken"]);

  if (!data.authToken) {
    chrome.tabs.create({
      url: chrome.runtime.getURL("auth.html")
    });
    return;
  }

  premiumBtn.disabled = true;
  premiumBtn.textContent = "Loading...";

  try {
    const response = await fetch(API_SUBSCRIBE_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${data.authToken}`
      }
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Не удалось оформить Premium.");
    }

    const result = await response.json();

    await chrome.storage.local.set({
      authUser: result.user
    });

    await renderState();
  } catch (error) {
    networkState.textContent = error.message;
  } finally {
    premiumBtn.disabled = false;
  }
}

// есть ли доступ к premium
function isPremiumUser(user) {
  return user && (user.role === "subscriber" || user.role === "admin");
}

// админ ли пользователь
function isAdmin(user) {
  return user && user.role === "admin";
}

// текст роли
function getRoleText(role) {
  switch (role) {
    case "subscriber":
      return "подписчик";
    case "admin":
      return "администратор";
    default:
      return "пользователь";
  }
}

// показываем или скрываем premium-часть
function renderPremiumAccess(user) {
  if (isPremiumUser(user)) {
    premiumBtn.textContent = "Premium";
    premiumBtn.classList.add("premium-active");

    evidenceCard.classList.remove("hidden");
    premiumLockCard.classList.add("hidden");

    verdictCard.classList.remove("hidden");
  } else {
    premiumBtn.textContent = "Premium";
    premiumBtn.classList.remove("premium-active");

    evidenceCard.classList.add("hidden");
    premiumLockCard.classList.remove("hidden");

    verdictCard.classList.remove("hidden");
  }
}

// текст для закрытого premium-блока
function renderPremiumLockedState() {
  evidenceState.textContent = "Подробное фактическое поведение доступно пользователям с Premium.";
  networkStats.innerHTML = "";
  domainsList.innerHTML = "";
  requestsList.innerHTML = "";
}

// показываем кнопку выхода, если пользователь есть
function renderAuthState(user) {
  if (!user) {
    logoutBtn.classList.add("hidden");
    return;
  }

  logoutBtn.classList.remove("hidden");
}

// выход из аккаунта
logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove(["authToken", "authUser"]);

  await chrome.storage.local.set({
    enabled: false,
    currentUrl: null,
    lastEvidence: null,
    isCollecting: false
  });

  chrome.runtime.sendMessage({
    type: "RESET_STATE"
  });

  await renderState();
});