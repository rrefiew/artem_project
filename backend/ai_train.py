import json
import numpy as np
import tensorflow as tf
from tensorflow.keras.models import Sequential
from tensorflow.keras.layers import Dense, Dropout, Embedding, LSTM
from tensorflow.keras.preprocessing.text import Tokenizer
from tensorflow.keras.preprocessing.sequence import pad_sequences
import pickle

MAX_VOCAB_SIZE = 5000
MAX_LENGTH = 200
EMBEDDING_DIM = 64
LSTM_UNITS = 64
EPOCHS = 50
BATCH_SIZE = 8

CATEGORIES = ["data_sharing", "tracking", "ads", "data_retention", "user_rights"]

#загрузка данных
def load_dataset(filepath='dataset.json'):
    with open(filepath, 'r', encoding='utf-8') as f:
        data = json.load(f)
    
    texts = [item['text'] for item in data]
    labels = np.array([[item['labels'][cat] for cat in CATEGORIES] for item in data])
    
    return texts, labels

# подготовка данных
def prepare_data(texts, labels):
    tokenizer = Tokenizer(num_words=MAX_VOCAB_SIZE, oov_token='<OOV>')
    tokenizer.fit_on_texts(texts)
    
    sequences = tokenizer.texts_to_sequences(texts)
    padded = pad_sequences(sequences, maxlen=MAX_LENGTH, padding='post', truncating='post')
    
    split = int(len(padded) * 0.8)
    X_train, X_val = padded[:split], padded[split:]
    y_train, y_val = labels[:split], labels[split:]
    
    return X_train, X_val, y_train, y_val, tokenizer

# создание модели
def create_model():
    model = Sequential([
        Embedding(input_dim=MAX_VOCAB_SIZE, output_dim=EMBEDDING_DIM, input_length=MAX_LENGTH),
        LSTM(LSTM_UNITS, dropout=0.2, recurrent_dropout=0.2),
        Dense(32, activation='relu'),
        Dropout(0.5),
        Dense(len(CATEGORIES), activation='sigmoid')
    ])
    
    model.compile(
        optimizer='adam',
        loss='binary_crossentropy',
        metrics=['accuracy', tf.keras.metrics.Precision(), tf.keras.metrics.Recall()]
    )
    
    return model

# обучение
def train():
    print("Загрузка датасета...")
    texts, labels = load_dataset()
    print(f"Загружено {len(texts)} примеров")
    
    print("Подготовка данных...")
    X_train, X_val, y_train, y_val, tokenizer = prepare_data(texts, labels)
    
    with open('tokenizer.pkl', 'wb') as f:
        pickle.dump(tokenizer, f)
    print("Токенизатор сохранён")
    
    print("Создание модели...")
    model = create_model()
    model.summary()
    
    print("\nОбучение...")
    history = model.fit(
        X_train, y_train,
        validation_data=(X_val, y_val),
        epochs=EPOCHS,
        batch_size=BATCH_SIZE,
        verbose=1
    )
    
    print("\nСохранение модели...")
    model.save('privacy_model.h5')
    print("Модель сохранена в privacy_model.h5")
    
    print(f"\nРезультаты:")
    print(f"  Точность (train): {history.history['accuracy'][-1]:.2%}")
    print(f"  Точность (val): {history.history['val_accuracy'][-1]:.2%}")

if __name__ == "__main__":
    train()