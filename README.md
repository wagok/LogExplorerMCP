# Log Explorer MCP

MCP сервер для интеллектуального анализа логов с кластеризацией.

## Идея

Логи — это огромные файлы, которые невозможно засунуть в контекст LLM. Традиционный подход (grep) требует знать что искать. Этот инструмент решает проблему иначе:

1. **Кластеризация** — автоматическое группирование похожих строк
2. **Lazy exploration** — сначала статистика и примеры, детали по запросу
3. **LLM-driven drill-down** — LLM сама решает куда углубляться
4. **Временной анализ** — динамика логов, детекция аномалий

## Быстрый старт

```bash
npm install
node test-cli.js /var/log/syslog
```

## Сценарий использования

```
LLM: "Проанализируй /var/log/app.log"

1. log_overview → "12M строк, 3 дня, пик в 14:00 вчера"

2. log_cluster → 
   Cluster A: 68% - "INFO request completed..." 
   Cluster B: 26% - "DEBUG cache hit/miss..."
   Cluster C: 4%  - "WARN connection timeout..."
   Cluster D: 2%  - "ERROR ..." ← интересно!

3. log_timeline(cluster_id=D) →
   "ERROR резко вырос с 100/час до 5000/час в 13:45"

4. log_cluster_drill(cluster_id=D) →
   D1: "ERROR database connection refused" (70%)
   D2: "ERROR null pointer in UserService" (20%)
   D3: "ERROR timeout calling payment API" (10%)

5. log_grep("database connection refused") →
   count: 3500, примеры с контекстом

6. log_fetch(...) → только когда нужны все строки
```

## Установка

```bash
git clone <repo>
cd log-explorer-mcp
npm install
```

## Использование

### Как MCP сервер

Добавьте в конфигурацию вашего MCP клиента:

```json
{
  "mcpServers": {
    "log-explorer": {
      "command": "node",
      "args": ["/path/to/log-explorer-mcp/server.js"]
    }
  }
}
```

### CLI для тестирования

```bash
# Сгенерировать тестовые логи
node generate-test-logs.cjs /tmp/test.log

# Проанализировать
node test-cli.js /tmp/test.log
```

## API Reference

### log_overview

Получить общую информацию о файле логов.

**Параметры:**
- `file` (string, required) — путь к файлу

**Ответ:**
```json
{
  "file": "/var/log/app.log",
  "size_human": "125.3 MB",
  "total_lines": 1250000,
  "timestamp_format": "iso8601",
  "time_range": {
    "start": "2024-01-15T00:00:00Z",
    "end": "2024-01-17T23:59:59Z"
  }
}
```

### log_cluster

Кластеризовать строки логов по схожести.

**Параметры:**
- `file` (string, required) — путь к файлу
- `max_clusters` (number, default: 10) — максимум кластеров (2-20)
- `threshold` (number, default: 0.4) — порог схожести (0.1-0.9)
- `filter` (string, optional) — фильтр строк

**Ответ:**
```json
{
  "total_lines": 1250000,
  "cluster_count": 8,
  "clusters": [
    {
      "id": 0,
      "count": 500000,
      "percent": "40.0%",
      "template": "INFO  [.*] Request completed in .* ms",
      "examples": ["INFO  [main] Request completed in 45 ms"]
    }
  ]
}
```

### log_cluster_drill

Создать подкластеры внутри выбранного кластера.

**Параметры:**
- `file` (string, required)
- `cluster_id` (number, required) — ID кластера из log_cluster
- `max_subclusters` (number, default: 5)

### log_timeline

Получить временную гистограмму логов.

**Параметры:**
- `file` (string, required)
- `cluster_id` (number, optional) — только для конкретного кластера
- `bucket_size` (string, default: "auto") — auto/minute/hour/day

**Ответ включает:**
- ASCII гистограмму
- Обнаруженные аномалии (спайки > 2σ)

### log_grep

Поиск по паттерну с подсчётом и примерами.

**Параметры:**
- `file` (string, required)
- `pattern` (string, required) — подстрока или `/regex/`
- `max_examples` (number, default: 5)
- `context_lines` (number, default: 0)

**Важно:** Возвращает только count и примеры, НЕ все строки!

### log_fetch

Получить сырые строки (использовать когда точно знаете что нужно).

**Параметры:**
- `file` (string, required)
- `filter` (string, optional)
- `offset` (number, default: 0)
- `limit` (number, default: 100)

## Алгоритм кластеризации

Используется token-based similarity:

1. Строки разбиваются на токены (слова, числа, пунктуация)
2. Для двух строк ищутся максимальные совпадающие блоки токенов
3. Формируется шаблон с `.*` на месте различий
4. Similarity = 2 × matched / (len_a + len_b)

Подробнее см. [ARCHITECTURE.md](ARCHITECTURE.md)

## Файлы проекта

```
├── CLAUDE.md          # Инструкции для Claude Code
├── README.md          # Этот файл
├── ARCHITECTURE.md    # Детальная архитектура
├── TODO.md            # Задачи на развитие
├── package.json       
├── server.js          # MCP сервер
├── clustering.js      # Алгоритм кластеризации
├── timestamps.js      # Парсинг временных меток
├── test-cli.js        # CLI для тестирования
└── generate-test-logs.cjs  # Генератор тестовых данных
```

## Лицензия

MIT
