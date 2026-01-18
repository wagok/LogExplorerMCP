#!/usr/bin/env node
/**
 * CLI для тестирования log-explorer без MCP
 */

import { LogClusterer } from './clustering.js';
import {
  detectTimestampFormat,
  extractTimestamp,
  calculateBucketSize,
  buildHistogram,
  formatHistogram
} from './timestamps.js';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

async function* readLines(filePath) {
  const rl = createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity
  });
  
  for await (const line of rl) {
    yield line;
  }
}

async function analyzeLog(filePath) {
  if (!existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }
  
  console.log(`\n📁 Analyzing: ${filePath}\n`);
  console.log('═'.repeat(60));
  
  // 1. Определяем формат времени
  console.log('\n🕐 Detecting timestamp format...');
  const sampleLines = [];
  let lineCount = 0;
  
  for await (const line of readLines(filePath)) {
    lineCount++;
    if (sampleLines.length < 100) {
      sampleLines.push(line);
    }
  }
  
  console.log(`   Total lines: ${lineCount}`);
  
  const tsFormat = detectTimestampFormat(sampleLines);
  if (tsFormat) {
    console.log(`   Detected format: ${tsFormat.pattern.name} (confidence: ${(tsFormat.confidence * 100).toFixed(0)}%)`);
  } else {
    console.log('   No timestamp format detected');
  }
  
  // 2. Кластеризация
  console.log('\n📊 Clustering logs...');
  const clusterer = new LogClusterer({ maxClusters: 8, threshold: 0.4 });
  const timestamps = [];
  
  for await (const line of readLines(filePath)) {
    clusterer.add(line);
    
    if (tsFormat) {
      const ts = extractTimestamp(line, tsFormat.pattern);
      if (ts) timestamps.push(ts);
    }
  }
  
  const stats = clusterer.getStats();
  
  console.log(`\n   Found ${stats.length} clusters:\n`);
  
  for (const cluster of stats) {
    const bar = '█'.repeat(Math.round(parseFloat(cluster.percent) / 5));
    console.log(`   [${cluster.id}] ${cluster.percent.padStart(5)}% ${bar}`);
    console.log(`       Template: ${cluster.template.substring(0, 70)}${cluster.template.length > 70 ? '...' : ''}`);
    console.log(`       Example:  ${cluster.examples[0].substring(0, 70)}${cluster.examples[0].length > 70 ? '...' : ''}`);
    console.log();
  }
  
  // 3. Временная динамика
  if (timestamps.length > 0) {
    console.log('═'.repeat(60));
    console.log('\n📈 Timeline analysis:\n');
    
    const sorted = timestamps.sort((a, b) => a - b);
    const bucket = calculateBucketSize(sorted[0], sorted[sorted.length - 1], 15);
    const histogram = buildHistogram(timestamps, bucket);
    
    console.log(`   Time range: ${sorted[0].toISOString()} to ${sorted[sorted.length - 1].toISOString()}`);
    console.log(`   Bucket size: ${bucket.unit}\n`);
    
    console.log(formatHistogram(histogram, 30).split('\n').map(l => '   ' + l).join('\n'));
    
    // Аномалии
    const counts = histogram.map(h => h.count);
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const stdDev = Math.sqrt(counts.reduce((sum, c) => sum + Math.pow(c - avg, 2), 0) / counts.length);
    
    const anomalies = histogram.filter(h => h.count > avg + 2 * stdDev);
    
    if (anomalies.length > 0) {
      console.log('\n   ⚠️  Anomalies detected:');
      for (const a of anomalies) {
        const deviation = ((a.count - avg) / stdDev).toFixed(1);
        console.log(`      ${a.start.toISOString().substring(11, 19)}: ${a.count} logs (${deviation}σ above average)`);
      }
    }
  }
  
  console.log('\n' + '═'.repeat(60));
  console.log('Done!\n');
}

// Запуск
const file = process.argv[2];
if (!file) {
  console.log('Usage: node test-cli.js <logfile>');
  console.log('\nExample: node test-cli.js /var/log/syslog');
  process.exit(1);
}

analyzeLog(file);
