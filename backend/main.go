package main

import (
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"time"

	"github.com/joho/godotenv"
	_ "github.com/lib/pq"
)

// структуры
type HandlerRequest struct {
	Email string `json:"email"`
}

type HandlerResponse struct {
	Success  bool     `json:"success"`
	Found    int      `json:"found"`
	IsLeaked bool     `json:"is_leaked"`
	Fields   []string `json:"fields"`
	Sources  []Source `json:"sources"`
}

type Source struct {
	Name   string   `json:"name"`
	Date   string   `json:"date"`
	Fields []string `json:"fields"`
}

// результат анализа политики конфиденциальности :/
type PrivacyAnalysis struct {
	URL        string   `json:"url"`
	Analyzed   bool     `json:"analyzed"`
	RiskLevel  string   `json:"risk_level"`
	Summary    []string `json:"summary"`
	Categories map[string]struct {
		Found      int     `json:"found"`
		Confidence float32 `json:"confidence"`
		Label      string  `json:"label"`
	} `json:"categories"`
	Cached bool   `json:"cached"`
	Error  string `json:"error,omitempty"`
}

var db *sql.DB

func main() {
	//подключение к бд
	godotenv.Load()

	conn := fmt.Sprintf("host=%s port=%s user=%s password=%s dbname=%s sslmode=disable",
		os.Getenv("DB_HOST"),
		os.Getenv("DB_PORT"),
		os.Getenv("DB_USER"),
		os.Getenv("DB_PASSWORD"),
		os.Getenv("DB_NAME"),
	)

	var err error
	db, err = sql.Open("postgres", conn)
	if err != nil {
		panic(err)
	}

	if err := db.Ping(); err != nil {
		log.Fatal("Не удалось подключиться к базе данных:", err)
	}

	fmt.Println("Подключено к базе данных")

	//http сервер
	http.HandleFunc("/api/check", handleCheck)
	http.HandleFunc("/api/analyze", handleAnalyze)

	fmt.Println("Сервер запущен на http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// хешируем емейлик
func hashEmail(email string) string {
	hash := sha256.Sum256([]byte(email))
	return fmt.Sprintf("%x", hash)
}

func handleCheck(w http.ResponseWriter, r *http.Request) {
	//разрешаем запросы от браузерного расширения
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	//читаем запрос от клиента
	var req HandlerRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Неверный формат запроса", http.StatusBadRequest)
		return
	}

	emailHash := hashEmail(req.Email)

	fmt.Printf("Проверка email: %s\n", req.Email)

	// проверка кэша в БД
	foundInCache, cachedResponse, err := checkCacheInDB(emailHash)
	if err != nil {
		log.Printf(" Ошибка проверки кэша: %v", err)
	}

	var response *HandlerResponse

	if foundInCache {
		// кэшик найден - возвращаем
		fmt.Println("Ответ из кэша БД")
		response = cachedResponse

	} else {
		// кэша нет
		fmt.Println("Кэш не найден, запрос к LeakCheck API...")

		response, err = queryLeakCheck(req.Email)
		if err != nil {
			log.Printf("Ошибка запроса к API: %v", err)
			http.Error(w, "Сервис временно недоступен", http.StatusBadGateway)
			return
		}

		// сохраняем в БД результат
		go func() {
			if err := saveToDB(emailHash, response); err != nil {
				log.Printf("Не удалось сохранить в БД: %v", err)
			} else {
				fmt.Println("Результат сохранён в кэш")
			}
		}()
	}

	// отправка ответа
	fmt.Printf("Найдено %d утечек, поля: %v\n", response.Found, response.Fields)

	w.Header().Set("Content-Type", "application/json")
	err = json.NewEncoder(w).Encode(response)
	if err != nil {
		log.Printf("Ошибка отправки ответа: %v", err)
		return
	}
}

// обработчик запроса на анализ сайта
func handleAnalyze(w http.ResponseWriter, r *http.Request) {
	// CORS
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")

	// читаем URL сайта из запроса
	var req struct {
		URL string `json:"url"`
	}
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil || req.URL == "" {
		http.Error(w, "Неверный запрос: укажите URL", http.StatusBadRequest)
		return
	}

	fmt.Printf("Анализ сайта: %s\n", req.URL)

	// Запускаем анализ
	result, err := analyzePrivacy(req.URL)
	if err != nil {
		log.Printf("Ошибка анализа: %v", err)
		// частичный результат с ошибкой
		result = &PrivacyAnalysis{
			URL:       req.URL,
			Analyzed:  false,
			Error:     err.Error(),
			RiskLevel: "unknown",
		}
	}

	// Отправляем ответ
	w.Header().Set("Content-Type", "application/json")
	err = json.NewEncoder(w).Encode(result)
	if err != nil {
		log.Printf("Ошибка отправки ответа: %v", err)
		return
	}
}

// запрос к LeakCheck
func queryLeakCheck(email string) (*HandlerResponse, error) {
	encodedEmail := url.QueryEscape(email)
	apiURL := fmt.Sprintf("https://leakcheck.io/api/public?check=%s", encodedEmail)

	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return nil, fmt.Errorf("ошибка создания запроса: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("ошибка запроса к API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API вернул статус: %d", resp.StatusCode)
	}

	var result HandlerResponse
	err = json.NewDecoder(resp.Body).Decode(&result)
	if err != nil {
		return nil, fmt.Errorf("ошибка парсинга ответа: %w", err)
	}

	result.IsLeaked = result.Found > 0

	return &result, nil
}

// ищем кэш в БД
func checkCacheInDB(email string) (bool, *HandlerResponse, error) {

	//ищем по емейлу и кэш не истек
	query := `
		SELECT is_leaked, leak_count, fields, sources
		FROM email_check
		WHERE email = $1 AND expires_at > NOW()
		LIMIT 1
		`
	var IsLeaked bool
	var Found int
	var FieldsJSON []byte
	var SourcesJSON []byte

	err := db.QueryRow(query, email).Scan(&IsLeaked, &Found, &FieldsJSON, &SourcesJSON)

	// если нет записи, то ее просто нет :) это не ошибка
	if err == sql.ErrNoRows {
		return false, nil, nil
	}

	if err != nil {
		return false, nil, fmt.Errorf("ошибка чтения кэша: %w", err)
	}

	// парс JSON
	var fields []string
	var sources []Source

	if len(FieldsJSON) > 0 {
		if err := json.Unmarshal(FieldsJSON, &fields); err != nil {
			return false, nil, fmt.Errorf("ошибка парсинга fields: %w", err)
		}
	}

	if len(SourcesJSON) > 0 {
		if err := json.Unmarshal(SourcesJSON, &sources); err != nil {
			return false, nil, fmt.Errorf("ошибка парсинга sources: %w", err)
		}
	}

	// ответик
	response := &HandlerResponse{
		Success:  true,
		Found:    Found,
		IsLeaked: IsLeaked,
		Fields:   fields,
		Sources:  sources,
	}

	return true, response, nil
}

// сохраняем кэш в БД
func saveToDB(email string, response *HandlerResponse) error {

	// Превращаем слайсы в JSON
	fieldsJSON, err := json.Marshal(response.Fields)
	if err != nil {
		return fmt.Errorf("ошибка кодирования fields: %w", err)
	}

	sourcesJSON, err := json.Marshal(response.Sources)
	if err != nil {
		return fmt.Errorf("ошибка кодирования sources: %w", err)
	}

	query := `
        INSERT INTO email_check (
            email, is_leaked, leak_count, fields, sources, expires_at
        ) VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')
        ON CONFLICT (email) DO UPDATE SET
            is_leaked = EXCLUDED.is_leaked,
            leak_count = EXCLUDED.leak_count,
            fields = EXCLUDED.fields,
            sources = EXCLUDED.sources,
            expires_at = NOW() + INTERVAL '7 days'
    `

	_, err = db.Exec(query, email, response.IsLeaked, response.Found, fieldsJSON, sourcesJSON)
	if err != nil {
		return fmt.Errorf("ошибка сохранения в БД: %w", err)
	}

	return nil
}

// к нейронке
func analyzePrivacy(url string) (*PrivacyAnalysis, error) {
	cmd := exec.Command("python", "ai_predict.py", url)

	output, err := cmd.Output()

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return nil, fmt.Errorf("скрипт упал: %s", string(exitErr.Stderr))
		}
		return nil, fmt.Errorf("ошибка запуска: %w", err)
	}

	var result PrivacyAnalysis
	err = json.Unmarshal(output, &result)
	if err != nil {
		return nil, fmt.Errorf("ошибка парсинга JSON: %w, данные: %s", err, string(output))
	}

	return &result, nil
}
