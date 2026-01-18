/**
 * Timestamp Parser Module
 * 
 * Автоматическое определение и извлечение временных меток из логов
 */

// Распространённые форматы временных меток
const TIMESTAMP_PATTERNS = [
  // ISO 8601
  {
    name: 'iso8601',
    regex: /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
    parse: (match) => new Date(match[1])
  },
  // Common log format: [15/Jan/2024:10:30:00 +0000]
  {
    name: 'clf',
    regex: /\[(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{4})\]/,
    parse: (match) => {
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, 
                       Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      return new Date(
        parseInt(match[3]), months[match[2]], parseInt(match[1]),
        parseInt(match[4]), parseInt(match[5]), parseInt(match[6])
      );
    }
  },
  // Syslog: Jan 15 10:30:00
  {
    name: 'syslog',
    regex: /(\w{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/,
    parse: (match) => {
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, 
                       Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const now = new Date();
      return new Date(
        now.getFullYear(), months[match[1]], parseInt(match[2]),
        parseInt(match[3]), parseInt(match[4]), parseInt(match[5])
      );
    }
  },
  // Simple date: 2024-01-15 10:30:00
  {
    name: 'simple',
    regex: /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/,
    parse: (match) => new Date(`${match[1]}T${match[2]}`)
  },
  // Epoch milliseconds: 1705315800000
  {
    name: 'epoch_ms',
    regex: /\b(1[4-9]\d{11})\b/,
    parse: (match) => new Date(parseInt(match[1]))
  },
  // Epoch seconds: 1705315800
  {
    name: 'epoch_s',
    regex: /\b(1[4-9]\d{8})\b/,
    parse: (match) => new Date(parseInt(match[1]) * 1000)
  },
  // Bracket format: [2024-01-15 10:30:00]
  {
    name: 'bracket',
    regex: /\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/,
    parse: (match) => new Date(match[1].replace(' ', 'T'))
  }
];

/**
 * Определяет формат временной метки из строк
 * @param {string[]} sampleLines - примеры строк лога
 * @returns {{pattern: object, confidence: number} | null}
 */
export function detectTimestampFormat(sampleLines) {
  const scores = new Map();
  
  for (const pattern of TIMESTAMP_PATTERNS) {
    let matches = 0;
    let validDates = 0;
    
    for (const line of sampleLines) {
      const match = line.match(pattern.regex);
      if (match) {
        matches++;
        try {
          const date = pattern.parse(match);
          if (date && !isNaN(date.getTime())) {
            validDates++;
          }
        } catch (e) {
          // Invalid date
        }
      }
    }
    
    if (matches > 0) {
      scores.set(pattern, { matches, validDates, confidence: validDates / sampleLines.length });
    }
  }
  
  // Выбираем паттерн с наибольшим confidence
  let bestPattern = null;
  let bestScore = 0;
  
  for (const [pattern, score] of scores) {
    if (score.confidence > bestScore) {
      bestScore = score.confidence;
      bestPattern = pattern;
    }
  }
  
  if (bestPattern && bestScore > 0.5) {
    return { pattern: bestPattern, confidence: bestScore };
  }
  
  return null;
}

/**
 * Извлекает временную метку из строки
 * @param {string} line 
 * @param {object} pattern 
 * @returns {Date | null}
 */
export function extractTimestamp(line, pattern) {
  const match = line.match(pattern.regex);
  if (match) {
    try {
      const date = pattern.parse(match);
      if (date && !isNaN(date.getTime())) {
        return date;
      }
    } catch (e) {
      // Invalid date
    }
  }
  return null;
}

/**
 * Вычисляет оптимальный размер bucket для гистограммы
 * @param {Date} minDate 
 * @param {Date} maxDate 
 * @param {number} targetBuckets - целевое количество bucket'ов
 * @returns {{size: number, unit: string}}
 */
export function calculateBucketSize(minDate, maxDate, targetBuckets = 20) {
  const diffMs = maxDate.getTime() - minDate.getTime();
  const targetBucketMs = diffMs / targetBuckets;
  
  // Выбираем ближайший "красивый" размер
  const units = [
    { name: 'second', ms: 1000 },
    { name: 'minute', ms: 60 * 1000 },
    { name: '5min', ms: 5 * 60 * 1000 },
    { name: '15min', ms: 15 * 60 * 1000 },
    { name: 'hour', ms: 60 * 60 * 1000 },
    { name: '6hour', ms: 6 * 60 * 60 * 1000 },
    { name: 'day', ms: 24 * 60 * 60 * 1000 },
    { name: 'week', ms: 7 * 24 * 60 * 60 * 1000 },
    { name: 'month', ms: 30 * 24 * 60 * 60 * 1000 }
  ];
  
  let best = units[0];
  for (const unit of units) {
    if (unit.ms <= targetBucketMs) {
      best = unit;
    }
  }
  
  return { size: best.ms, unit: best.name };
}

/**
 * Строит гистограмму по времени
 * @param {Date[]} timestamps 
 * @param {{size: number, unit: string}} bucket 
 * @returns {Array<{start: Date, end: Date, count: number}>}
 */
export function buildHistogram(timestamps, bucket) {
  if (timestamps.length === 0) return [];
  
  const sorted = [...timestamps].sort((a, b) => a.getTime() - b.getTime());
  const minTime = sorted[0].getTime();
  const maxTime = sorted[sorted.length - 1].getTime();
  
  const buckets = [];
  let currentStart = Math.floor(minTime / bucket.size) * bucket.size;
  
  while (currentStart <= maxTime) {
    buckets.push({
      start: new Date(currentStart),
      end: new Date(currentStart + bucket.size),
      count: 0
    });
    currentStart += bucket.size;
  }
  
  for (const ts of sorted) {
    const bucketIdx = Math.floor((ts.getTime() - buckets[0].start.getTime()) / bucket.size);
    if (bucketIdx >= 0 && bucketIdx < buckets.length) {
      buckets[bucketIdx].count++;
    }
  }
  
  return buckets;
}

/**
 * Форматирует гистограмму для вывода
 * @param {Array} histogram 
 * @param {number} maxWidth - максимальная ширина ASCII-бара
 * @returns {string}
 */
export function formatHistogram(histogram, maxWidth = 40) {
  if (histogram.length === 0) return 'No data';
  
  const maxCount = Math.max(...histogram.map(b => b.count));
  const lines = [];
  
  for (const bucket of histogram) {
    const barLen = maxCount > 0 ? Math.round((bucket.count / maxCount) * maxWidth) : 0;
    const bar = '█'.repeat(barLen) + '░'.repeat(maxWidth - barLen);
    const time = bucket.start.toISOString().substring(0, 19).replace('T', ' ');
    lines.push(`${time} │${bar}│ ${bucket.count}`);
  }
  
  return lines.join('\n');
}
