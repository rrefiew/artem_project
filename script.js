document.addEventListener('DOMContentLoaded', () => {
    const emailInput = document.getElementById('emailInput');
    const checkBtn = document.getElementById('checkBtn');
    const resultDiv = document.getElementById('result');

    checkBtn.addEventListener('click', async () => {
        const email = emailInput.value.trim();
        
        // валидация
        if (!email || !email.includes('@')) {
            showResult('Введите корректный email', 'error');
            return;
        }

        setLoading(true);

        try {
            // запрос к серверу
            const response = await fetch('http://localhost:8080/api/check', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ email: email })
            });

            if (!response.ok) {
                throw new Error(`Сервер вернул статус: ${response.status}`);
            }

            const data = await response.json();
            displayResult(data);

        } catch (error) {
            console.error('Ошибка:', error);
            showResult(`Ошибка: ${error.message}`, 'error');
        } finally {
            setLoading(false);
        }
2    });

    function setLoading(loading) {
        checkBtn.disabled = loading;
        if (loading) {
            showResult('Проверка...', 'loading');
        }
    }

    // показать результат
    function showResult(html, type) {
        resultDiv.style.display = 'block';
        resultDiv.className = '';
        resultDiv.classList.add(`result-${type}`);
        resultDiv.innerHTML = html;
    }

    // отображение ответа от сервера
    function displayResult(data) {
        if (data.is_leaked) {
            let fieldsHtml = '';
            if (data.fields && data.fields.length > 0) {
                fieldsHtml = `
                    <p><strong>Что утекло:</strong></p>
                    <ul class="fields-list">
                       ${data.fields.map(f => `<li>• ${f}</li>`).join('')}
                    </ul>
                `;
            }

            let sourcesHtml = '';
            if (data.sources && data.sources.length > 0) {
                sourcesHtml = `
                    <p><strong>Источники:</strong></p>
                    <ul class="sources-list">
                        ${data.sources.map(s => `<li>${s.name} (${s.date})</li>`).join('')}
                    </ul>
                `;
            }

            const html = `
                <strong>Email скомпрометирован!</strong><br><br>
                Найдено утечек: ${data.found}<br><br>
                ${fieldsHtml}
                ${sourcesHtml}
            `;
            showResult(html, 'leaked');

        } else {
            const html = `
                <strong>Утечек не найдено!</strong><br><br>
                Этот email не обнаружен в базах утечек.
            `;
            showResult(html, 'safe');
        }
    }
});

//АНАЛИЗ САЙТА
// элементы для анализа
const siteInput = document.getElementById('siteInput');
const analyzeBtn = document.getElementById('analyzeBtn');
const privacyResult = document.getElementById('privacyResult');

// обработчик кнопки анализировать
analyzeBtn?.addEventListener('click', async () => {
    const url = siteInput.value.trim();
    
    // Простая валидация URL
    if (!url || !url.startsWith('http')) {
        showPrivacyResult('Введите корректный URL (например, https://example.com)', 'medium');
        return;
    }

    // блокируем кнопочку пока делаем работу
    analyzeBtn.disabled = true;
    showPrivacyResult('Анализируем политику конфиденциальности...', 'medium');

    try {
        // запрос на сервер
        const response = await fetch('http://localhost:8080/api/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: url })
        });

        if (!response.ok) {
            throw new Error(`Сервер вернул статус: ${response.status}`);
        }

        const data = await response.json();
        displayPrivacyResult(data);

    } catch (error) {
        console.error('Ошибка анализа:', error);
        showPrivacyResult(`${error.message}`, 'high');
    } finally {
        // кнопка разблок
        analyzeBtn.disabled = false;
    }
});

// показать результат анализа
function showPrivacyResult(html, level) {
    if (privacyResult) {
        privacyResult.style.display = 'block';
        privacyResult.className = '';
        privacyResult.classList.add(`privacy-${level}`);
        privacyResult.innerHTML = html;
    }
}

// ответ от нейросетки
function displayPrivacyResult(data) {
    // текстовые метки для уровней риска
    const riskLabels = {
        'low': 'Низкий риск',
        'medium': 'Средний риск',
        'high': 'Высокий риск',
        'unknown': 'Неизвестно'
    };
    
    // если ошибка от сервера
    if (data.error) {
        showPrivacyResult(data.error, 'high');
        return;
    }
    
    // список найденных категорий
    let categoriesHtml = '';
    if (data.categories) {
        for (const [key, value] of Object.entries(data.categories)) {
            if (value.found) {
                const confidence = Math.round(value.confidence * 100);
                const label = value.label || key;
                categoriesHtml += `<li><strong>${label}:</strong> ${confidence}%</li>`;
            }
        }
    }
    
    // краткие выводы
    const summaryHtml = data.summary?.length 
        ? `<ul class="privacy-list">${data.summary.map(s => `<li>${s}</li>`).join('')}</ul>` 
        : '';
    
    // финальный html
    const html = `
        <strong>${riskLabels[data.risk_level] || 'Неизвестно'}</strong><br><br>
        ${summaryHtml}
        ${categoriesHtml ? `<p><strong>Найдено:</strong></p><ul class="privacy-list">${categoriesHtml}</ul>` : ''}
        <p style="margin-top:10px;font-size:11px;color:#666;">Сайт: ${data.url}</p>
    `;
    
    showPrivacyResult(html, data.risk_level);
}