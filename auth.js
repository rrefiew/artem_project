// адреса апи
const API_REGISTER_URL = "http://localhost:8080/api/register";
const API_SUBSCRIBE_URL = "http://localhost:8080/api/subscribe";
const API_LOGIN_URL = "http://localhost:8080/api/login";

//элементы страницы авторизации
const authState = document.getElementById("authState");
const authEmail = document.getElementById("authEmail");
const authPassword = document.getElementById("authPassword");
const loginBtn = document.getElementById("loginBtn");
const registerBtn = document.getElementById("registerBtn");
const closeAuthPageBtn = document.getElementById("closeAuthPageBtn");

// вход
loginBtn.addEventListener("click", async () => {
  await login();
});

// регистрация
registerBtn.addEventListener("click", async () => {
  await register();
});

// закрываем страницу входа
closeAuthPageBtn.addEventListener("click", () => {
  window.close();
});

// регистрация нового пользователя
async function register() {
  const email = authEmail.value.trim();
  const password = authPassword.value.trim();

  // сначала проверяем email
  if (!isValidEmail(email)) {
    authState.textContent = "Введите корректный email.";
    return;
  }

  // пароль делаем хотя бы 6 символов
  if (password.length < 6) {
    authState.textContent = "Пароль должен быть не короче 6 символов.";
    return;
  }

  await authRequest(API_REGISTER_URL, email, password);
}

// вход существующего пользователя
async function login() {
  const email = authEmail.value.trim();
  const password = authPassword.value.trim();

  // проверяем email до запроса
  if (!isValidEmail(email)) {
    authState.textContent = "Введите корректный email.";
    return;
  }

  if (!password) {
    authState.textContent = "Введите пароль.";
    return;
  }

  await authRequest(API_LOGIN_URL, email, password);
}

// общий запрос для входа и регистрации
async function authRequest(url, email, password) {
  authState.textContent = "Выполняется вход...";

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });

    // если backend вернул ошибку, показываем текст
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Ошибка авторизации");
    }

    const result = await response.json();

    // сохраняем токен и пользователя в расширении
    await chrome.storage.local.set({
      authToken: result.token,
      authUser: result.user
    });

    // после входа сразу оформляем premium
    await activatePremiumAfterAuth(result.token);

    authState.textContent = "Готово. Аккаунт сохранен";

    // закрываем страницу через небольшую паузу
    setTimeout(() => {
      window.close();
    }, 800);
  } catch (error) {
    authState.textContent = error.message;
  }
}

// оформляем premium после входа или регистрации
async function activatePremiumAfterAuth(token) {
  const response = await fetch(API_SUBSCRIBE_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`
    }
  });

  // если premium не оформился, прокидываем ошибку выше
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(errorText || "Не удалось оформить Premium.");
  }

  const result = await response.json();

  // обновляем пользователя уже с ролью subscriber
  await chrome.storage.local.set({
    authUser: result.user
  });
}

//проверка email
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}