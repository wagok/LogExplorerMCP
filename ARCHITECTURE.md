# Архитектура Log Explorer MCP

## Общая схема

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM (Claude/другой)                      │
└─────────────────────────┬───────────────────────────────────┘
                          │ MCP Protocol (JSON-RPC over stdio)
┌─────────────────────────▼───────────────────────────────────┐
│                     server.js                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Tool Handlers:                                       │   │
│  │  - handleLogOverview()                              │   │
│  │  - handleLogCluster()                               │   │
│  │  - handleLogClusterDrill()                          │   │
│  │  - handleLogTimeline()                              │   │
│  │  - handleLogGrep()                                  │   │
│  │  - handleLogFetch()                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                          │                                  │
│  ┌───────────────────────▼─────────────────────────────┐   │
│  │              File Cache (Map)                        │   │
│  │   key: "filepath:maxClusters:threshold:filter"      │   │
│  │   value: { clusterer, timestamps, totalLines, ... } │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┴─────────────────┐
        ▼                                   ▼
┌───────────────────┐             ┌───────────────────┐
│   clustering.js   │             │   timestamps.js   │
│                   │             │                   │
│ - tokenize()      │             │ - detectFormat()  │
│ - extractTemplate()│            │ - extractTS()     │
│ - LogCluster      │             │ - buildHistogram()│
│ - LogClusterer    │             │ - formatHist()    │
└───────────────────┘             └───────────────────┘
```

## Модуль кластеризации (clustering.js)

### Токенизация

```javascript
tokenize("User john logged in")
// → [
//   { text: "User", isDelim: false },
//   { text: " ", isDelim: true },
//   { text: "john", isDelim: false },
//   { text: " ", isDelim: true },
//   { text: "logged", isDelim: false },
//   { text: " ", isDelim: true },
//   { text: "in", isDelim: false }
// ]
```

Разделение на токены позволяет:
- Не ломать слова при поиске совпадений
- Отличать значимые токены от разделителей
- Быстрее работать (меньше элементов чем символов)

### Алгоритм поиска совпадающих блоков

```
findMatchingTokenBlocks(tokensA, tokensB):
  1. Строим DP матрицу для longest common suffix
  2. Собираем все потенциальные блоки (где dp[i][j] > 0)
  3. Фильтруем: оставляем только блоки с значимыми токенами
  4. Сортируем по score = len + count(significant_tokens)
  5. Жадно выбираем непересекающиеся блоки
  6. Сортируем результат по позиции в строке A
```

Сложность: O(m×n) где m, n — количество токенов.

### Класс LogCluster

```javascript
class LogCluster {
  id: number           // Уникальный ID
  template: string     // Текущий шаблон "INFO .* started"
  staticParts: string[] // Статические части ["INFO ", " started"]
  count: number        // Количество строк в кластере
  examples: string[]   // До 5 примеров строк
  timestamps: Date[]   // Временные метки (для timeline)
  
  tryAdd(line, threshold): boolean  // Попытка добавить строку
  similarity(line): number          // Расчёт схожести
}
```

### Класс LogClusterer

```javascript
class LogClusterer {
  threshold: number     // Минимальная схожесть (default 0.4)
  maxClusters: number   // Максимум кластеров (default 10)
  clusters: LogCluster[]
  
  add(line, timestamp): number  // Добавить строку, вернуть cluster_id
  getCluster(id): LogCluster
  getStats(): ClusterStats[]
}
```

При превышении maxClusters — удаляется самый маленький кластер.

## Модуль временных меток (timestamps.js)

### Поддерживаемые форматы

| Формат | Пример | Regex |
|--------|--------|-------|
| ISO 8601 | `2024-01-15T10:30:00Z` | `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}` |
| CLF | `[15/Jan/2024:10:30:00 +0000]` | `\[\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}` |
| Syslog | `Jan 15 10:30:00` | `\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}` |
| Simple | `2024-01-15 10:30:00` | `\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}` |
| Epoch ms | `1705315800000` | `1[4-9]\d{11}` |
| Epoch s | `1705315800` | `1[4-9]\d{8}` |

### Автодетекция формата

```javascript
detectTimestampFormat(sampleLines):
  1. Для каждого паттерна из TIMESTAMP_PATTERNS:
     - Считаем сколько строк матчатся
     - Проверяем что parse даёт валидную дату
  2. Выбираем паттерн с confidence > 50%
  3. Возвращаем { pattern, confidence }
```

### Гистограммы

```javascript
calculateBucketSize(minDate, maxDate, targetBuckets=20):
  // Выбирает "красивый" размер bucket: second, minute, 5min, hour, day...

buildHistogram(timestamps, bucket):
  // Возвращает [{start, end, count}, ...]

formatHistogram(histogram, maxWidth=40):
  // ASCII визуализация с █ и ░
```

## MCP Server (server.js)

### Кэширование

```javascript
const fileCache = new Map();
// key: "filepath:maxClusters:threshold:filter"
// value: { totalLines, clusterer, timestamps, timestampPattern }
```

Кэш позволяет не перечитывать файл при последовательных вызовах `log_cluster`, `log_timeline`, `log_cluster_drill`.

### Обработчики инструментов

#### log_overview
```
→ statSync для размера
→ getOrCreateClustering для подсчёта строк и детекции времени
← { file, size, total_lines, timestamp_format, time_range }
```

#### log_cluster
```
→ getOrCreateClustering с параметрами
→ clusterer.getStats()
← { total_lines, cluster_count, clusters: [{id, count, percent, template, examples}] }
```

#### log_cluster_drill
```
→ Находим родительский кластер
→ Создаём новый LogClusterer с threshold=0.5
→ Перечитываем файл, добавляя только строки похожие на родителя
← { parent_cluster, subclusters: [...] }
```

#### log_timeline
```
→ getOrCreateClustering
→ Если cluster_id задан — фильтруем timestamps
→ calculateBucketSize + buildHistogram
→ Детекция аномалий (> avg + 2σ)
← { bucket_size, histogram_ascii, anomalies }
```

#### log_grep
```
→ Итерируем файл с фильтром
→ Считаем matches, собираем до max_examples
← { total_matches, examples }  // НЕ все строки!
```

#### log_fetch
```
→ Итерируем файл с фильтром, offset, limit
← { lines: [{line_num, line}, ...] }  // Сырые данные
```

## Поток данных типичного сеанса

```
1. LLM: log_overview("/var/log/app.log")
   ← "12M строк, 3 дня, формат ISO8601"

2. LLM: log_cluster(file, max_clusters=8)
   [Кластеризация всего файла, кэширование]
   ← 8 кластеров с шаблонами и примерами

3. LLM: log_timeline(file, cluster_id=5)
   [Использует кэш, фильтрует timestamps]
   ← Гистограмма, аномалия в 13:45

4. LLM: log_cluster_drill(file, cluster_id=5)
   [Перечитывает файл, субкластеризация]
   ← 4 подкластера внутри ERROR

5. LLM: log_grep(file, "connection refused")
   ← count=3500, 5 примеров

6. LLM: log_fetch(file, filter="connection refused", limit=50)
   ← 50 сырых строк для детального анализа
```

## Расширяемость

### Добавление нового формата времени
1. Добавить объект в `TIMESTAMP_PATTERNS` в timestamps.js
2. Реализовать regex и функцию parse

### Добавление нового инструмента
1. Добавить описание в `TOOLS` в server.js
2. Реализовать `handleNewTool()` 
3. Добавить case в switch обработчика

### Улучшение алгоритма кластеризации
Основная точка — функция `findMatchingTokenBlocks()` в clustering.js.
Можно экспериментировать с:
- Весами токенов (числа vs слова)
- Минимальной длиной блока
- Стратегией выбора блоков
