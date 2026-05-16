import sys
import os
import re
import json
import pickle
from urllib.parse import urlparse, urljoin

import numpy as np
import requests

# скрываем ворнинги тензорфлоу
os.environ["TF_CPP_MIN_LOG_LEVEL"] = "3"
os.environ["TF_ENABLE_ONEDNN_OPTS"] = "0"
os.environ["PYTHONIOENCODING"] = "utf-8"

import tensorflow as tf
from tensorflow.keras.models import load_model
from tensorflow.keras.preprocessing.sequence import pad_sequences


# настройки
CATEGORIES = ["data_sharing", "tracking", "ads", "data_retention", "user_rights"]

LABELS = {
    "data_sharing": "Data sharing",
    "tracking": "Tracking",
    "ads": "Ads",
    "data_retention": "Data retention",
    "user_rights": "User rights"
}

MAX_LENGTH = 200
THRESHOLD = 0.5

MODEL_PATH = "privacy_model.h5"
TOKENIZER_PATH = "tokenizer.pkl"

MAX_TEXT_LENGTH = 15000
REQUEST_TIMEOUT = 15

HEADERS = {
    "User-Agent": "Mozilla/5.0 PrivacyMonitor/1.0"
}


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


def output_json(data):
    sys.stdout.write(json.dumps(data, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def normalize_url(url):
    """
    Приводим URL к нормальному виду.
    Если пользователь передал example.com, превращаем в https://example.com.
    """
    url = url.strip()

    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    return url


def get_origin(url):
    """
    Из https://example.com/some/page делаем https://example.com.
    Это нужно, чтобы искать privacy policy от корня сайта.
    """
    parsed = urlparse(url)
    return f"{parsed.scheme}://{parsed.netloc}"


def clean_html(text):
    """
    Убираем HTML-теги, скрипты, стили и лишние пробелы.
    """
    text = re.sub(r"<script[^>]*>.*?</script>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<style[^>]*>.*?</style>", " ", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<noscript[^>]*>.*?</noscript>", " ", text, flags=re.DOTALL | re.IGNORECASE)

    text = re.sub(r"<[^>]+>", " ", text)

    text = text.replace("&nbsp;", " ")
    text = text.replace("&amp;", "&")
    text = text.replace("&quot;", '"')
    text = text.replace("&#39;", "'")

    text = re.sub(r"&[a-zA-Z]+;", " ", text)
    text = re.sub(r"\s+", " ", text)

    return text.strip()


def fetch_html(url):
    """
    Скачиваем HTML-страницу.
    Если сайт недоступен или вернул не HTML, возвращаем пустую строку.
    """
    try:
        response = requests.get(
            url,
            headers=HEADERS,
            timeout=REQUEST_TIMEOUT,
            allow_redirects=True
        )

        if response.status_code != 200:
            return ""

        content_type = response.headers.get("Content-Type", "").lower()

        if content_type and "text/html" not in content_type and "text/plain" not in content_type:
            return ""

        return response.content.decode("utf-8", errors="ignore")

    except Exception as e:
        log(f"Fetch failed for {url}: {e}")
        return ""


def extract_privacy_links(base_url, html):
    """
    Пытаемся найти ссылку на privacy policy на главной странице сайта.
    Например:
    <a href="/privacy-policy">Privacy Policy</a>
    """
    links = []

    href_pattern = r'href=["\']([^"\']+)["\']'
    hrefs = re.findall(href_pattern, html, flags=re.IGNORECASE)

    privacy_words = [
        "privacy",
        "policy",
        "confidentiality",
        "personal-data",
        "data-protection",
        "privacy-policy"
    ]

    for href in hrefs:
        lower_href = href.lower()

        if any(word in lower_href for word in privacy_words):
            full_url = urljoin(base_url, href)
            links.append(full_url)

    return links


def build_candidate_policy_urls(url):
    """
    Строим список URL, где может находиться политика конфиденциальности.
    Сначала проверяем ссылки с главной страницы.
    Потом проверяем типовые пути.
    """
    url = normalize_url(url)
    origin = get_origin(url)

    candidates = []

    parsed = urlparse(url)
    current_path = parsed.path.lower()

    # Если пользователь уже находится на странице privacy/policy,
    # сначала проверяем именно текущий URL.
    if "privacy" in current_path or "policy" in current_path:
        candidates.append(url)

    # Пытаемся найти ссылку на privacy policy на главной странице.
    homepage_html = fetch_html(origin)

    if homepage_html:
        candidates.extend(extract_privacy_links(origin, homepage_html))

    # Типовые пути privacy policy.
    fallback_paths = [
        "/privacy",
        "/privacy-policy",
        "/privacy_policy",
        "/privacy.html",
        "/privacy-policy.html",
        "/policy",
        "/policies/privacy",
        "/legal/privacy",
        "/terms/privacy",
        "/confidentiality",
        "/personal-data",
        "/data-protection"
    ]

    for path in fallback_paths:
        candidates.append(origin.rstrip("/") + path)

    # Убираем дубликаты, но сохраняем порядок.
    unique_candidates = []
    seen = set()

    for candidate in candidates:
        if candidate not in seen:
            unique_candidates.append(candidate)
            seen.add(candidate)

    return unique_candidates


def fetch_page_text(url):
    """
    Ищем и скачиваем privacy policy.
    Возвращаем:
    - текст политики
    - URL политики
    """
    candidates = build_candidate_policy_urls(url)

    for candidate in candidates:
        log(f"Trying policy URL: {candidate}")

        html = fetch_html(candidate)

        if not html:
            continue

        text = clean_html(html)

        if len(text) >= 100:
            return text[:MAX_TEXT_LENGTH], candidate

    return "", ""


def analyze_text(text, model, tokenizer):
    """
    Прогоняем текст политики через модель.
    Модель возвращает вероятности по категориям:
    - data_sharing
    - tracking
    - ads
    - data_retention
    - user_rights
    """
    seq = tokenizer.texts_to_sequences([text])
    pad = pad_sequences(seq, maxlen=MAX_LENGTH, padding="post", truncating="post")

    pred = model.predict(pad, verbose=0)[0]

    result = {
        "categories": {},
        "summary": [],
        "risk_level": "low"
    }

    risk_count = 0

    for i, cat in enumerate(CATEGORIES):
        confidence = float(pred[i])

        if confidence > THRESHOLD:
            result["categories"][cat] = {
                "found": 1,
                "confidence": round(confidence, 3),
                "label": LABELS.get(cat, cat)
            }

            risk_count += 1

    if risk_count == 0:
        result["risk_level"] = "low"
        result["summary"].append("Minimum risks")
    elif risk_count <= 2:
        result["risk_level"] = "medium"
        result["summary"].append("Moderate data collection")
    else:
        result["risk_level"] = "high"
        result["summary"].append("Active data sharing")

    return result


def load_model_and_tokenizer():
    """
    Загружаем обученную модель и токенизатор.
    """
    log("Loading model...")

    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"Model not found: {MODEL_PATH}")

    if not os.path.exists(TOKENIZER_PATH):
        raise FileNotFoundError(f"Tokenizer not found: {TOKENIZER_PATH}")

    model = load_model(MODEL_PATH)

    with open(TOKENIZER_PATH, "rb") as f:
        tokenizer = pickle.load(f)

    log("Model loaded successfully")

    return model, tokenizer


def main():
    try:
        if len(sys.argv) < 2:
            output_json({
                "error": "No URL provided",
                "analyzed": False
            })
            sys.exit(0)

        url = normalize_url(sys.argv[1])

        log(f"Processing: {url}")

        model, tokenizer = load_model_and_tokenizer()

        text, policy_url = fetch_page_text(url)

        log(f"Policy URL: {policy_url}")
        log(f"Downloaded {len(text)} characters")

        if len(text) < 100:
            output_json({
                "error": "Could not fetch privacy policy",
                "url": url,
                "policy_url": policy_url,
                "analyzed": False
            })
            sys.exit(0)

        log("Running analysis...")

        result = analyze_text(text, model, tokenizer)

        result["url"] = url
        result["policy_url"] = policy_url
        result["analyzed"] = True

        output_json(result)

        log("Done")

    except FileNotFoundError as e:
        output_json({
            "error": str(e),
            "analyzed": False
        })
        sys.exit(0)

    except Exception as e:
        log(f"FATAL ERROR: {e}")

        output_json({
            "error": f"Internal error: {str(e)}",
            "analyzed": False
        })
        sys.exit(0)


if __name__ == "__main__":
    main()