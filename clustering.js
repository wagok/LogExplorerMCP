/**
 * Log Clustering Module
 * 
 * Токен-based кластеризация с построением шаблонов
 */

/**
 * Токенизатор
 */
export function tokenize(str) {
  const tokens = [];
  const regex = /(\s+|[^\s\w]+|[\w]+)/g;
  let match;
  
  while ((match = regex.exec(str)) !== null) {
    const text = match[1];
    const isDelim = /^\s+$/.test(text) || /^[^\s\w]+$/.test(text);
    tokens.push({ text, isDelim });
  }
  
  return tokens;
}

/**
 * Находит совпадающие блоки токенов
 */
function findMatchingTokenBlocks(tokensA, tokensB) {
  const blocks = [];
  const m = tokensA.length;
  const n = tokensB.length;
  
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensA[i - 1].text === tokensB[j - 1].text) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      }
    }
  }
  
  const usedA = new Set();
  const usedB = new Set();
  const candidates = [];
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (dp[i][j] > 0) {
        const len = dp[i][j];
        const aStart = i - len;
        const bStart = j - len;
        const hasSignificant = tokensA.slice(aStart, i).some(t => !t.isDelim && t.text.length > 1);
        if (hasSignificant) {
          candidates.push({
            aStart, aEnd: i, bStart, bEnd: j, len,
            score: len + tokensA.slice(aStart, i).filter(t => !t.isDelim).length
          });
        }
      }
    }
  }
  
  candidates.sort((a, b) => b.score - a.score);
  
  for (const cand of candidates) {
    let overlap = false;
    for (let i = cand.aStart; i < cand.aEnd; i++) {
      if (usedA.has(i)) { overlap = true; break; }
    }
    for (let j = cand.bStart; j < cand.bEnd; j++) {
      if (usedB.has(j)) { overlap = true; break; }
    }
    
    if (!overlap) {
      blocks.push(cand);
      for (let i = cand.aStart; i < cand.aEnd; i++) usedA.add(i);
      for (let j = cand.bStart; j < cand.bEnd; j++) usedB.add(j);
    }
  }
  
  blocks.sort((a, b) => a.aStart - b.aStart);
  return blocks;
}

/**
 * Извлекает шаблон из двух строк
 */
export function extractTemplate(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const blocks = findMatchingTokenBlocks(tokensA, tokensB);
  
  if (blocks.length === 0) {
    return { template: '.*', similarity: 0, staticParts: [] };
  }
  
  const parts = [];
  const staticParts = [];
  let lastEnd = 0;
  let matchedLen = 0;
  
  for (const block of blocks) {
    if (block.aStart > lastEnd) parts.push('.*');
    
    const matchedTokens = tokensA.slice(block.aStart, block.aEnd);
    const matchedText = matchedTokens.map(t => t.text).join('');
    parts.push(matchedText);
    staticParts.push(matchedText);
    matchedLen += matchedText.length;
    lastEnd = block.aEnd;
  }
  
  if (lastEnd < tokensA.length) parts.push('.*');
  
  return {
    template: parts.join(''),
    similarity: (2 * matchedLen) / (a.length + b.length),
    staticParts
  };
}

/**
 * Объединяет шаблон с новой строкой
 */
export function mergeWithTemplate(tmpl, newStr) {
  const pseudoStr = tmpl.staticParts.join('\x00');
  const tokensA = tokenize(pseudoStr);
  const tokensB = tokenize(newStr);
  const blocks = findMatchingTokenBlocks(tokensA, tokensB);
  
  if (blocks.length === 0) {
    return { template: '.*', similarity: 0, staticParts: [] };
  }
  
  const newStaticParts = [];
  const parts = [];
  let lastEnd = 0;
  
  for (const block of blocks) {
    if (block.aStart > lastEnd) parts.push('.*');
    
    const matchedTokens = tokensA.slice(block.aStart, block.aEnd);
    const matchedText = matchedTokens.map(t => t.text).join('').replace(/\x00/g, '');
    
    if (matchedText.trim()) {
      parts.push(matchedText);
      newStaticParts.push(matchedText);
    } else {
      parts.push('.*');
    }
    lastEnd = block.aEnd;
  }
  
  if (lastEnd < tokensA.length) parts.push('.*');
  
  let template = parts.join('').replace(/(\.\*)+/g, '.*');
  const matchedLen = newStaticParts.reduce((sum, p) => sum + p.length, 0);
  
  return {
    template,
    similarity: (2 * matchedLen) / (tmpl.template.length + newStr.length),
    staticParts: newStaticParts
  };
}

/**
 * Кластер логов
 */
export class LogCluster {
  constructor(id, firstLine) {
    this.id = id;
    this.template = firstLine;
    this.staticParts = [firstLine];
    this.count = 1;
    this.examples = [firstLine];
    this.maxExamples = 5;
    this.timestamps = []; // Для временной статистики
  }
  
  tryAdd(line, threshold = 0.4) {
    const result = mergeWithTemplate(
      { template: this.template, staticParts: this.staticParts },
      line
    );
    
    if (result.similarity >= threshold) {
      this.template = result.template;
      this.staticParts = result.staticParts;
      this.count++;
      
      if (this.examples.length < this.maxExamples) {
        this.examples.push(line);
      }
      return true;
    }
    return false;
  }
  
  similarity(line) {
    const result = mergeWithTemplate(
      { template: this.template, staticParts: this.staticParts },
      line
    );
    return result.similarity;
  }
  
  addTimestamp(ts) {
    this.timestamps.push(ts);
  }
  
  toJSON() {
    return {
      id: this.id,
      count: this.count,
      template: this.template,
      examples: this.examples
    };
  }
}

/**
 * Кластеризатор логов
 */
export class LogClusterer {
  constructor(options = {}) {
    this.threshold = options.threshold || 0.4;
    this.maxClusters = options.maxClusters || 10;
    this.clusters = [];
    this.nextId = 0;
  }
  
  add(line, timestamp = null) {
    let bestCluster = null;
    let bestSimilarity = 0;
    
    for (const cluster of this.clusters) {
      const sim = cluster.similarity(line);
      if (sim > bestSimilarity && sim >= this.threshold) {
        bestSimilarity = sim;
        bestCluster = cluster;
      }
    }
    
    if (bestCluster) {
      bestCluster.tryAdd(line, this.threshold);
      if (timestamp) bestCluster.addTimestamp(timestamp);
      return bestCluster.id;
    }
    
    const newCluster = new LogCluster(this.nextId++, line);
    if (timestamp) newCluster.addTimestamp(timestamp);
    
    if (this.clusters.length >= this.maxClusters) {
      this._mergeMostSimilar();
    }
    
    this.clusters.push(newCluster);
    return newCluster.id;
  }
  
  _mergeMostSimilar() {
    let minCount = Infinity;
    let minIdx = 0;
    
    for (let i = 0; i < this.clusters.length; i++) {
      if (this.clusters[i].count < minCount) {
        minCount = this.clusters[i].count;
        minIdx = i;
      }
    }
    
    this.clusters.splice(minIdx, 1);
  }
  
  getCluster(id) {
    return this.clusters.find(c => c.id === id);
  }
  
  getStats() {
    const total = this.clusters.reduce((sum, c) => sum + c.count, 0);
    
    return this.clusters
      .map(c => ({
        ...c.toJSON(),
        percent: total > 0 ? ((c.count / total) * 100).toFixed(1) : '0'
      }))
      .sort((a, b) => b.count - a.count);
  }
}
