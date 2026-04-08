package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
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

	fmt.Println("Сервер запущен на http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
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

	fmt.Printf("Проверка email: %s\n", req.Email)

	// запрос к LeakCheck
	response, err := queryLeakCheck(req.Email)
	if err != nil {
		log.Printf("Ошибка запроса к API: %v", err)
		http.Error(w, "Сервис временно недоступен", http.StatusBadGateway)
		return
	}

	fmt.Printf("Найдено %d утечек, поля: %v\n", response.Found, response.Fields)

	// отправляем ответ
	w.Header().Set("Content-Type", "application/json")

	err = json.NewEncoder(w).Encode(response)
	if err != nil {
		log.Printf("Ошибка отправки ответа: %v", err)
		return
	}
}

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
