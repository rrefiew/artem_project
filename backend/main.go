package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/mail"
	"net/url"
	"os"
	"os/exec"
	"strings"
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

type AuthRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	Success bool     `json:"success"`
	Token   string   `json:"token,omitempty"`
	User    UserInfo `json:"user,omitempty"`
	Error   string   `json:"error,omitempty"`
}

type UserInfo struct {
	ID           int    `json:"id"`
	Email        string `json:"email"`
	Role         string `json:"role"`
	PremiumUntil string `json:"premium_until,omitempty"`
}

type AdminUserInfo struct {
	ID           int     `json:"id"`
	Email        string  `json:"email"`
	Role         string  `json:"role"`
	PremiumUntil *string `json:"premium_until,omitempty"`
	CreatedAt    string  `json:"created_at"`
}

type ChangeUserRoleRequest struct {
	UserID int    `json:"user_id"`
	Role   string `json:"role"`
}

// результат анализа политики конфиденциальности
type PrivacyAnalysis struct {
	URL       string   `json:"url"`
	PolicyURL string   `json:"policy_url,omitempty"`
	Analyzed  bool     `json:"analyzed"`
	RiskLevel string   `json:"risk_level"`
	Summary   []string `json:"summary"`

	Categories map[string]struct {
		Found      int     `json:"found"`
		Confidence float32 `json:"confidence"`
		Label      string  `json:"label"`
	} `json:"categories"`

	Cached bool   `json:"cached"`
	Error  string `json:"error,omitempty"`
}

var db *sql.DB
var dbAvailable bool

func main() {
	// подключение к бд
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

	dbAvailable = true
	fmt.Println("Подключено к базе данных")

	// http сервер
	http.HandleFunc("/api/register", handleRegister)
	http.HandleFunc("/api/login", handleLogin)
	http.HandleFunc("/api/me", handleMe)
	http.HandleFunc("/api/subscribe", handleSubscribe)

	// админ здох
	// http.HandleFunc("/api/admin/users", handleAdminUsers)
	// http.HandleFunc("/api/admin/users/role", handleAdminChangeUserRole)

	http.HandleFunc("/api/check", handleCheck)

	fmt.Println("Сервер запущен на http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

// хешируем емейл для кэша
func hashEmail(email string) string {
	hash := sha256.Sum256([]byte(email))
	return fmt.Sprintf("%x", hash)
}

// хешируем пароль
func hashPassword(password string) string {
	hash := sha256.Sum256([]byte(password))
	return fmt.Sprintf("%x", hash)
}

// сравниваем пароль с хешем
func checkPassword(password string, passwordHash string) bool {
	return hashPassword(password) == passwordHash
}

// приводим email к нормальному виду
func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// проверяем формат email
func isValidEmail(email string) bool {
	email = normalizeEmail(email)

	if email == "" {
		return false
	}

	_, err := mail.ParseAddress(email)
	return err == nil
}

// создаем случайный токен
func generateToken() (string, error) {
	bytes := make([]byte, 32)

	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}

	return hex.EncodeToString(bytes), nil
}

// хешируем токен перед сохранением в бд
func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return fmt.Sprintf("%x", hash)
}

// создаем сессию пользователя
func createSession(userID int) (string, error) {
	// сначала создаем токен, который уйдет на клиент
	token, err := generateToken()
	if err != nil {
		return "", err
	}

	// в бд сохраняем только хеш токена
	tokenHash := hashToken(token)

	// чистим старые сессии
	_, _ = db.Exec(`
		DELETE FROM sessions
		WHERE expires_at <= NOW()
	`)

	// создаем новую сессию на 30 дней
	_, err = db.Exec(`
		INSERT INTO sessions (user_id, token_hash, expires_at)
		VALUES ($1, $2, NOW() + INTERVAL '30 days')
	`, userID, tokenHash)

	if err != nil {
		return "", err
	}

	return token, nil
}

// достаем bearer token из заголовка
func getBearerToken(r *http.Request) string {
	authHeader := r.Header.Get("Authorization")

	if !strings.HasPrefix(authHeader, "Bearer ") {
		return ""
	}

	return strings.TrimSpace(strings.TrimPrefix(authHeader, "Bearer "))
}

// получаем пользователя по токену
func getUserFromRequest(r *http.Request) (UserInfo, error) {
	token := getBearerToken(r)

	if token == "" {
		return UserInfo{}, fmt.Errorf("empty token")
	}

	tokenHash := hashToken(token)

	// если premium закончился, пользователь удаляется
	refreshExpiredPremiumByToken(tokenHash)

	var user UserInfo

	// ищем пользователя по активной сессии
	err := db.QueryRow(`
		SELECT u.id, u.email, u.role, COALESCE(u.premium_until::text, '')
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		WHERE s.token_hash = $1
		  AND s.expires_at > NOW()
		LIMIT 1
	`, tokenHash).Scan(
		&user.ID,
		&user.Email,
		&user.Role,
		&user.PremiumUntil,
	)

	if err != nil {
		return UserInfo{}, err
	}

	return user, nil
}

// удаляем пользователя, если premium закончился
func refreshExpiredPremiumByToken(tokenHash string) {
	// сначала ищем пользователя с истекшим premium
	// потом удаляем его сессии и сам аккаунт
	_, _ = db.Exec(`
		WITH expired_users AS (
			SELECT u.id
			FROM users u
			JOIN sessions s ON s.user_id = u.id
			WHERE s.token_hash = $1
			  AND s.expires_at > NOW()
			  AND u.role = 'subscriber'
			  AND u.premium_until IS NOT NULL
			  AND u.premium_until <= NOW()
		),
		deleted_sessions AS (
			DELETE FROM sessions
			WHERE user_id IN (SELECT id FROM expired_users)
		)
		DELETE FROM users
		WHERE id IN (SELECT id FROM expired_users)
	`, tokenHash)
}

// проверяем, что пользователь админ
func requireAdmin(r *http.Request) (UserInfo, error) {
	user, err := getUserFromRequest(r)
	if err != nil {
		return UserInfo{}, err
	}

	if user.Role != "admin" {
		return UserInfo{}, fmt.Errorf("admin role required")
	}

	return user, nil
}

// проверяем допустимую роль
func isAllowedRole(role string) bool {
	return role == "user" || role == "subscriber" || role == "admin"
}

// cors для расширения
func setCorsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
}

// проверка email на утечки
func handleCheck(w http.ResponseWriter, r *http.Request) {
	setCorsHeaders(w)

	// браузер может сначала прислать options
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}

	var req HandlerRequest
	err := json.NewDecoder(r.Body).Decode(&req)
	if err != nil {
		http.Error(w, "Неверный формат запроса", http.StatusBadRequest)
		return
	}

	req.Email = normalizeEmail(req.Email)

	if !isValidEmail(req.Email) {
		http.Error(w, "Введите корректный email", http.StatusBadRequest)
		return
	}

	// в кэше храним не email, а его хеш
	emailHash := hashEmail(req.Email)

	fmt.Printf("Проверка email: %s\n", req.Email)

	// сначала смотрим кэш в бд
	foundInCache, cachedResponse, err := checkCacheInDB(emailHash)
	if err != nil {
		log.Printf("Ошибка проверки кэша: %v", err)
	}

	var response *HandlerResponse

	if foundInCache {
		fmt.Println("Ответ из кэша БД")
		response = cachedResponse
	} else {
		fmt.Println("Кэш не найден, запрос к LeakCheck API...")

		// если в кэше нет, идем во внешний api
		response, err = queryLeakCheck(req.Email)
		if err != nil {
			log.Printf("Ошибка запроса к API: %v", err)
			http.Error(w, "Сервис временно недоступен", http.StatusBadGateway)
			return
		}

		// сохраняем результат в кэш
		go func() {
			if err := saveToDB(emailHash, response); err != nil {
				log.Printf("Не удалось сохранить в БД: %v", err)
			} else {
				fmt.Println("Результат сохранён в кэш")
			}
		}()
	}

	fmt.Printf("Найдено %d утечек, поля: %v\n", response.Found, response.Fields)

	w.Header().Set("Content-Type", "application/json")
	err = json.NewEncoder(w).Encode(response)
	if err != nil {
		log.Printf("Ошибка отправки ответа: %v", err)
		return
	}
}

// вход пользователя
func handleLogin(w http.ResponseWriter, r *http.Request) {
	setCorsHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}

	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Неверный формат запроса", http.StatusBadRequest)
		return
	}

	req.Email = normalizeEmail(req.Email)

	if !isValidEmail(req.Email) {
		http.Error(w, "Введите корректный email", http.StatusBadRequest)
		return
	}

	var user UserInfo
	var passwordHash string

	// ищем пользователя по email
	err := db.QueryRow(`
		SELECT id, email, role, COALESCE(premium_until::text, ''), password_hash
		FROM users
		WHERE email = $1
	`, req.Email).Scan(
		&user.ID,
		&user.Email,
		&user.Role,
		&user.PremiumUntil,
		&passwordHash,
	)

	if err != nil {
		http.Error(w, "Неверный email или пароль", http.StatusUnauthorized)
		return
	}

	// сравниваем хеш введенного пароля с хешем в бд
	if !checkPassword(req.Password, passwordHash) {
		http.Error(w, "Неверный email или пароль", http.StatusUnauthorized)
		return
	}

	// если пароль верный, создаем новую сессию
	token, err := createSession(user.ID)
	if err != nil {
		log.Printf("Ошибка создания сессии: %v", err)
		http.Error(w, "Ошибка создания сессии", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Success: true,
		Token:   token,
		User:    user,
	})
}

// регистрация пользователя
func handleRegister(w http.ResponseWriter, r *http.Request) {
	setCorsHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}

	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Неверный формат запроса", http.StatusBadRequest)
		return
	}

	req.Email = normalizeEmail(req.Email)

	if !isValidEmail(req.Email) {
		http.Error(w, "Введите корректный email", http.StatusBadRequest)
		return
	}

	if len(req.Password) < 6 {
		http.Error(w, "Пароль должен быть не короче 6 символов", http.StatusBadRequest)
		return
	}

	// пароль в открытом виде не сохраняем
	passwordHash := hashPassword(req.Password)

	var user UserInfo

	// при регистрации роль всегда user
	err := db.QueryRow(`
		INSERT INTO users (email, password_hash, role)
		VALUES ($1, $2, 'user')
		RETURNING id, email, role, COALESCE(premium_until::text, '')
	`, req.Email, passwordHash).Scan(
		&user.ID,
		&user.Email,
		&user.Role,
		&user.PremiumUntil,
	)

	if err != nil {
		log.Printf("Ошибка регистрации: %v", err)
		http.Error(w, "Пользователь уже существует", http.StatusConflict)
		return
	}

	// сразу создаем сессию после регистрации
	token, err := createSession(user.ID)
	if err != nil {
		log.Printf("Ошибка создания сессии: %v", err)
		http.Error(w, "Ошибка создания сессии", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Success: true,
		Token:   token,
		User:    user,
	})
}

// текущий пользователь по токену
func handleMe(w http.ResponseWriter, r *http.Request) {
	setCorsHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodGet {
		http.Error(w, "Метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}

	// по токену определяем текущего пользователя
	user, err := getUserFromRequest(r)
	if err != nil {
		http.Error(w, "Не авторизован", http.StatusUnauthorized)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Success: true,
		User:    user,
	})
}

// оформление premium на 30 секунд
func handleSubscribe(w http.ResponseWriter, r *http.Request) {
	setCorsHeaders(w)

	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusOK)
		return
	}

	if r.Method != http.MethodPost {
		http.Error(w, "Метод не поддерживается", http.StatusMethodNotAllowed)
		return
	}

	// premium можно оформить только после входа
	user, err := getUserFromRequest(r)
	if err != nil {
		http.Error(w, "Сначала войдите в аккаунт", http.StatusUnauthorized)
		return
	}

	// админ уже имеет доступ, ему premium не нужен
	if user.Role == "admin" {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(AuthResponse{
			Success: true,
			User:    user,
		})
		return
	}

	var updated UserInfo

	// выдаем premium на 30 секунд
	err = db.QueryRow(`
		UPDATE users
		SET role = 'subscriber',
		    premium_until = NOW() + INTERVAL '30 seconds',
		    updated_at = NOW()
		WHERE id = $1
		RETURNING id, email, role, COALESCE(premium_until::text, '')
	`, user.ID).Scan(
		&updated.ID,
		&updated.Email,
		&updated.Role,
		&updated.PremiumUntil,
	)

	if err != nil {
		log.Printf("Ошибка оформления Premium: %v", err)
		http.Error(w, "Не удалось оформить Premium", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(AuthResponse{
		Success: true,
		User:    updated,
	})
}

// запрос к LeakCheck
func queryLeakCheck(email string) (*HandlerResponse, error) {
	// email передаем во внешний api в url-encoded виде
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

	// если внешний api вернул ошибку, отдаем ее выше
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

// ищем кэш в бд
func checkCacheInDB(email string) (bool, *HandlerResponse, error) {
	query := `
		SELECT is_leaked, leak_count, fields, sources
		FROM email_check
		WHERE email = $1 AND expires_at > NOW()
		LIMIT 1
		`

	var isLeaked bool
	var found int
	var fieldsJSON []byte
	var sourcesJSON []byte

	err := db.QueryRow(query, email).Scan(&isLeaked, &found, &fieldsJSON, &sourcesJSON)

	// если записи нет, то просто идем в api
	if err == sql.ErrNoRows {
		return false, nil, nil
	}

	if err != nil {
		return false, nil, fmt.Errorf("ошибка чтения кэша: %w", err)
	}

	var fields []string
	var sources []Source

	// разбираем список полей, которые утекли
	if len(fieldsJSON) > 0 {
		if err := json.Unmarshal(fieldsJSON, &fields); err != nil {
			return false, nil, fmt.Errorf("ошибка парсинга fields: %w", err)
		}
	}

	// разбираем источники утечек
	if len(sourcesJSON) > 0 {
		if err := json.Unmarshal(sourcesJSON, &sources); err != nil {
			return false, nil, fmt.Errorf("ошибка парсинга sources: %w", err)
		}
	}

	response := &HandlerResponse{
		Success:  true,
		Found:    found,
		IsLeaked: isLeaked,
		Fields:   fields,
		Sources:  sources,
	}

	return true, response, nil
}

// сохраняем результат проверки email
func saveToDB(email string, response *HandlerResponse) error {
	// поля и источники храним json-ом
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

// анализ политики. НЕТ
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
