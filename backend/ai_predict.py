import sys
import os
import re
import json
import numpy as np

# скрываем ворнинги тензорфлоу
os.environ['TF_CPP_MIN_LOG_LEVEL'] = '3'
os.environ['TF_ENABLE_ONEDNN_OPTS'] = '0'
os.environ['PYTHONIOENCODING'] = 'utf-8'

import tensorflow as tf
from tensorflow.keras.models import load_model
from tensorflow.keras.preprocessing.sequence import pad_sequences
import pickle
import requests

# настройки
CATEGORIES = ["data_sharing", "tracking", "ads", "data_retention", "user_rights"]
MAX_LENGTH = 200
THRESHOLD = 0.5
MODEL_PATH = 'privacy_model.h5'
TOKENIZER_PATH = 'tokenizer.pkl'

def log(msg):
    sys.stderr.write(msg + '\n')
    sys.stderr.flush()

def output_json(data):
    sys.stdout.write(json.dumps(data, ensure_ascii=False) + '\n')
    sys.stdout.flush()

# убираем html теги
def clean_html(text):
    text = re.sub(r'<script[^>]*>.*?</script>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<style[^>]*>.*?</style>', ' ', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'&[a-zA-Z]+;', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

# скачиваем страницу
def fetch_page_text(url):
    headers = {'User-Agent': 'Mozilla/5.0'}
    paths = ['', '/privacy', '/privacy-policy', '/privacy.html', '/policy']
    
    for path in paths:
        try:
            full_url = url.rstrip('/') + path
            resp = requests.get(full_url, headers=headers, timeout=15)
            if resp.status_code == 200:
                return clean_html(resp.content.decode('utf-8', errors='ignore'))[:15000]
        except:
            continue
    return ""

# предсказание модели
def analyze_text(text, model, tokenizer):
    seq = tokenizer.texts_to_sequences([text])
    pad = pad_sequences(seq, maxlen=MAX_LENGTH, padding='post', truncating='post')
    pred = model.predict(pad, verbose=0)[0]
    
    result = {"categories": {}, "summary": [], "risk_level": "low"}
    
    labels = {
        "data_sharing": "Data sharing",
        "tracking": "Tracking",
        "ads": "Ads",
        "data_retention": "Data retention",
        "user_rights": "User rights"
    }
    
    risk_count = 0
    for i, cat in enumerate(CATEGORIES):
        if float(pred[i]) > THRESHOLD:
            result["categories"][cat] = {"found": 1, "confidence": round(float(pred[i]), 3), "label": labels.get(cat, cat)}
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

# загрузка модели
def load_model_and_tokenizer():
    log("Loading model...")
    if not os.path.exists(MODEL_PATH):
        raise FileNotFoundError(f"Model not found: {MODEL_PATH}")
    if not os.path.exists(TOKENIZER_PATH):
        raise FileNotFoundError(f"Tokenizer not found: {TOKENIZER_PATH}")
    
    model = load_model(MODEL_PATH)
    with open(TOKENIZER_PATH, 'rb') as f:
        tokenizer = pickle.load(f)
    
    log("Model loaded successfully")
    return model, tokenizer

# точка входа
def main():
    try:
        # проверка аргументов
        if len(sys.argv) < 2:
            output_json({"error": "No URL provided", "analyzed": False})
            sys.exit(0)
        
        url = sys.argv[1]
        log(f"Processing: {url}")
        
        # загрузка модели
        model, tokenizer = load_model_and_tokenizer()
        
        # скачивание текста
        text = fetch_page_text(url)
        log(f"Downloaded {len(text)} characters")
        
        if len(text) < 100:
            output_json({"error": "Could not fetch privacy policy", "url": url, "analyzed": False})
            sys.exit(0)
        
        # анализ
        log("Running analysis...")
        result = analyze_text(text, model, tokenizer)
        result["url"] = url
        result["analyzed"] = True
        
        # вывод результата
        output_json(result)
        log("Done")
        
    except FileNotFoundError as e:
        output_json({"error": str(e), "analyzed": False})
        sys.exit(0)
    except Exception as e:
        log(f"FATAL ERROR: {e}")
        output_json({"error": f"Internal error: {str(e)}", "analyzed": False})
        sys.exit(0)

if __name__ == "__main__":
    main()