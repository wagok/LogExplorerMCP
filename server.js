#!/usr/bin/env node
/**
 * Log Explorer MCP Server
 * 
 * MCP сервер для интеллектуального анализа логов с кластеризацией
 * 
 * Tools:
 * - log_overview: общая информация о файле логов
 * - log_cluster: кластеризация логов с шаблонами
 * - log_cluster_drill: углубление в конкретный кластер
 * - log_timeline: временная динамика
 * - log_grep: поиск с примерами (без полного вывода)
 * - log_fetch: получение сырых строк по фильтру
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { createReadStream, statSync, existsSync } from 'fs';
import { createInterface } from 'readline';

import { LogClusterer, LogCluster, extractTemplate } from './clustering.js';
import {
  detectTimestampFormat,
  extractTimestamp,
  calculateBucketSize,
  buildHistogram,
  formatHistogram
} from './timestamps.js';

// Кэш для обработанных файлов
const fileCache = new Map();

/**
 * Читает строки из файла
 */
async function* readLines(filePath, options = {}) {
  const { skip = 0, limit = Infinity, filter = null } = options;
  
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity
  });
  
  let lineNum = 0;
  let yielded = 0;
  
  for await (const line of rl) {
    lineNum++;
    
    if (lineNum <= skip) continue;
    if (yielded >= limit) break;
    
    if (filter) {
      if (typeof filter === 'string' && !line.includes(filter)) continue;
      if (filter instanceof RegExp && !filter.test(line)) continue;
    }
    
    yielded++;
    yield { lineNum, line };
  }
}

/**
 * Получает или создаёт кластеризацию для файла
 */
async function getOrCreateClustering(filePath, options = {}) {
  const { maxClusters = 10, threshold = 0.4, filter = null, forceRefresh = false } = options;
  
  const cacheKey = `${filePath}:${maxClusters}:${threshold}:${filter || ''}`;
  
  if (!forceRefresh && fileCache.has(cacheKey)) {
    return fileCache.get(cacheKey);
  }
  
  const clusterer = new LogClusterer({ maxClusters, threshold });
  const timestamps = [];
  let totalLines = 0;
  let timestampPattern = null;
  const sampleLines = [];
  
  // Первый проход: определяем формат времени из первых 100 строк
  for await (const { line } of readLines(filePath, { limit: 100, filter })) {
    sampleLines.push(line);
  }
  
  const formatResult = detectTimestampFormat(sampleLines);
  if (formatResult) {
    timestampPattern = formatResult.pattern;
  }
  
  // Основной проход: кластеризация
  for await (const { line } of readLines(filePath, { filter })) {
    totalLines++;
    
    let timestamp = null;
    if (timestampPattern) {
      timestamp = extractTimestamp(line, timestampPattern);
    }
    
    clusterer.add(line, timestamp);
    
    if (timestamp) {
      timestamps.push(timestamp);
    }
  }
  
  const result = {
    totalLines,
    clusterer,
    timestamps,
    timestampPattern,
    timestampFormat: timestampPattern?.name || null
  };
  
  fileCache.set(cacheKey, result);
  return result;
}

// Определение инструментов
const TOOLS = [
  {
    name: 'log_overview',
    description: 'Get overview of a log file: total lines, time range, detected timestamp format',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' }
      },
      required: ['file']
    }
  },
  {
    name: 'log_cluster',
    description: 'Cluster log lines by similarity. Returns cluster IDs, counts, templates and examples. Use for initial exploration.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' },
        max_clusters: { type: 'number', description: 'Maximum number of clusters (2-20)', default: 10 },
        threshold: { type: 'number', description: 'Similarity threshold (0.0-1.0)', default: 0.4 },
        filter: { type: 'string', description: 'Optional: only cluster lines containing this substring' }
      },
      required: ['file']
    }
  },
  {
    name: 'log_cluster_drill',
    description: 'Drill down into a specific cluster, creating sub-clusters for more detail',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' },
        cluster_id: { type: 'number', description: 'ID of cluster to drill into' },
        max_subclusters: { type: 'number', description: 'Maximum sub-clusters', default: 5 }
      },
      required: ['file', 'cluster_id']
    }
  },
  {
    name: 'log_timeline',
    description: 'Get temporal distribution of logs or a specific cluster. Shows histogram of log frequency over time.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' },
        cluster_id: { type: 'number', description: 'Optional: specific cluster ID' },
        bucket_size: { type: 'string', description: 'Bucket size: auto, minute, hour, day', default: 'auto' }
      },
      required: ['file']
    }
  },
  {
    name: 'log_grep',
    description: 'Search logs with pattern. Returns COUNT and a few EXAMPLES only - use for quick exploration before log_fetch',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' },
        pattern: { type: 'string', description: 'Search pattern (substring or /regex/)' },
        max_examples: { type: 'number', description: 'Max examples to return', default: 5 },
        context_lines: { type: 'number', description: 'Context lines around match', default: 0 }
      },
      required: ['file', 'pattern']
    }
  },
  {
    name: 'log_fetch',
    description: 'Fetch raw log lines. Use only when you know exactly what you need.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path to log file' },
        filter: { type: 'string', description: 'Filter pattern' },
        offset: { type: 'number', description: 'Skip first N matching lines', default: 0 },
        limit: { type: 'number', description: 'Max lines to return', default: 100 }
      },
      required: ['file']
    }
  }
];

// Обработчики инструментов
async function handleLogOverview({ file }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  const stats = statSync(file);
  const { totalLines, timestamps, timestampFormat } = await getOrCreateClustering(file);
  
  let timeRange = null;
  if (timestamps.length > 0) {
    const sorted = timestamps.sort((a, b) => a - b);
    timeRange = {
      start: sorted[0].toISOString(),
      end: sorted[sorted.length - 1].toISOString(),
      duration: `${Math.round((sorted[sorted.length - 1] - sorted[0]) / 1000 / 60)} minutes`
    };
  }
  
  return {
    file,
    size_bytes: stats.size,
    size_human: formatBytes(stats.size),
    total_lines: totalLines,
    timestamp_format: timestampFormat,
    time_range: timeRange
  };
}

async function handleLogCluster({ file, max_clusters = 10, threshold = 0.4, filter = null }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  const { totalLines, clusterer } = await getOrCreateClustering(file, {
    maxClusters: Math.min(Math.max(max_clusters, 2), 20),
    threshold: Math.min(Math.max(threshold, 0.1), 0.9),
    filter
  });
  
  const stats = clusterer.getStats();
  
  return {
    total_lines: totalLines,
    cluster_count: stats.length,
    filter: filter || null,
    clusters: stats.map(c => ({
      id: c.id,
      count: c.count,
      percent: c.percent + '%',
      template: c.template,
      examples: c.examples.slice(0, 3)
    }))
  };
}

async function handleLogClusterDrill({ file, cluster_id, max_subclusters = 5 }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  const { clusterer } = await getOrCreateClustering(file);
  const parentCluster = clusterer.getCluster(cluster_id);
  
  if (!parentCluster) {
    return { error: `Cluster ${cluster_id} not found. Run log_cluster first.` };
  }
  
  // Создаём субкластеризатор
  const subClusterer = new LogClusterer({
    maxClusters: max_subclusters,
    threshold: 0.5 // Более строгий порог для детализации
  });
  
  // Перечитываем файл, фильтруя по шаблону родительского кластера
  for await (const { line } of readLines(file)) {
    if (parentCluster.similarity(line) >= 0.4) {
      subClusterer.add(line);
    }
  }
  
  const stats = subClusterer.getStats();
  
  return {
    parent_cluster_id: cluster_id,
    parent_template: parentCluster.template,
    parent_count: parentCluster.count,
    subcluster_count: stats.length,
    subclusters: stats.map(c => ({
      id: c.id,
      count: c.count,
      percent: c.percent + '%',
      template: c.template,
      examples: c.examples.slice(0, 2)
    }))
  };
}

async function handleLogTimeline({ file, cluster_id = null, bucket_size = 'auto' }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  const { timestamps, clusterer, timestampPattern } = await getOrCreateClustering(file);
  
  if (!timestampPattern) {
    return { error: 'No timestamp format detected in log file' };
  }
  
  let filteredTimestamps = timestamps;
  let clusterInfo = null;
  
  if (cluster_id !== null) {
    const cluster = clusterer.getCluster(cluster_id);
    if (!cluster) {
      return { error: `Cluster ${cluster_id} not found` };
    }
    clusterInfo = { id: cluster_id, template: cluster.template };
    
    // Собираем timestamps только для этого кластера
    filteredTimestamps = [];
    for await (const { line } of readLines(file)) {
      if (cluster.similarity(line) >= 0.4) {
        const ts = extractTimestamp(line, timestampPattern);
        if (ts) filteredTimestamps.push(ts);
      }
    }
  }
  
  if (filteredTimestamps.length === 0) {
    return { error: 'No timestamps found', cluster: clusterInfo };
  }
  
  const sorted = filteredTimestamps.sort((a, b) => a - b);
  let bucket;
  
  if (bucket_size === 'auto') {
    bucket = calculateBucketSize(sorted[0], sorted[sorted.length - 1]);
  } else {
    const sizes = {
      minute: { size: 60 * 1000, unit: 'minute' },
      hour: { size: 60 * 60 * 1000, unit: 'hour' },
      day: { size: 24 * 60 * 60 * 1000, unit: 'day' }
    };
    bucket = sizes[bucket_size] || sizes.hour;
  }
  
  const histogram = buildHistogram(filteredTimestamps, bucket);
  const ascii = formatHistogram(histogram);
  
  // Находим аномалии (buckets с необычно высоким count)
  const counts = histogram.map(h => h.count);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const stdDev = Math.sqrt(counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length);
  
  const anomalies = histogram
    .filter(h => h.count > avg + 2 * stdDev)
    .map(h => ({
      time: h.start.toISOString(),
      count: h.count,
      deviation: ((h.count - avg) / stdDev).toFixed(1) + 'σ'
    }));
  
  return {
    cluster: clusterInfo,
    bucket_size: bucket.unit,
    total_entries: filteredTimestamps.length,
    time_range: {
      start: sorted[0].toISOString(),
      end: sorted[sorted.length - 1].toISOString()
    },
    histogram_ascii: ascii,
    anomalies: anomalies.length > 0 ? anomalies : null
  };
}

async function handleLogGrep({ file, pattern, max_examples = 5, context_lines = 0 }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  let filter;
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    try {
      filter = new RegExp(pattern.slice(1, -1));
    } catch (e) {
      return { error: `Invalid regex: ${e.message}` };
    }
  } else {
    filter = pattern;
  }
  
  const examples = [];
  let count = 0;
  const contextBuffer = [];
  
  for await (const { lineNum, line } of readLines(file)) {
    // Поддержка контекста
    if (context_lines > 0) {
      contextBuffer.push({ lineNum, line });
      if (contextBuffer.length > context_lines * 2 + 1) {
        contextBuffer.shift();
      }
    }
    
    const matches = typeof filter === 'string' 
      ? line.includes(filter)
      : filter.test(line);
    
    if (matches) {
      count++;
      
      if (examples.length < max_examples) {
        if (context_lines > 0) {
          examples.push({
            line_num: lineNum,
            match: line,
            context: contextBuffer.map(c => c.line)
          });
        } else {
          examples.push({
            line_num: lineNum,
            line
          });
        }
      }
    }
  }
  
  return {
    pattern,
    total_matches: count,
    examples_shown: examples.length,
    examples,
    hint: count > max_examples 
      ? `Use log_fetch with filter="${pattern}" to get more lines`
      : null
  };
}

async function handleLogFetch({ file, filter = null, offset = 0, limit = 100 }) {
  if (!existsSync(file)) {
    return { error: `File not found: ${file}` };
  }
  
  const lines = [];
  let totalMatched = 0;
  
  for await (const { lineNum, line } of readLines(file, { filter })) {
    totalMatched++;
    
    if (totalMatched > offset && lines.length < limit) {
      lines.push({ line_num: lineNum, line });
    }
    
    if (lines.length >= limit) break;
  }
  
  return {
    filter,
    offset,
    limit,
    returned: lines.length,
    total_scanned: totalMatched,
    lines
  };
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

// Создаём и запускаем сервер
const server = new Server(
  { name: 'log-explorer', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    let result;
    
    switch (name) {
      case 'log_overview':
        result = await handleLogOverview(args);
        break;
      case 'log_cluster':
        result = await handleLogCluster(args);
        break;
      case 'log_cluster_drill':
        result = await handleLogClusterDrill(args);
        break;
      case 'log_timeline':
        result = await handleLogTimeline(args);
        break;
      case 'log_grep':
        result = await handleLogGrep(args);
        break;
      case 'log_fetch':
        result = await handleLogFetch(args);
        break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true
        };
    }
    
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Log Explorer MCP server running');
}

main().catch(console.error);
