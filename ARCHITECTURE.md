# Log Explorer MCP Architecture

## General Schema

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM (Claude/other)                       │
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

## Clustering Module (clustering.js)

### Tokenization

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

Token separation allows:
- Not breaking words when searching for matches
- Distinguishing significant tokens from delimiters
- Faster processing (fewer elements than characters)

### Matching Blocks Algorithm

```
findMatchingTokenBlocks(tokensA, tokensB):
  1. Build DP matrix for longest common suffix
  2. Collect all potential blocks (where dp[i][j] > 0)
  3. Filter: keep only blocks with significant tokens
  4. Sort by score = len + count(significant_tokens)
  5. Greedily select non-overlapping blocks
  6. Sort result by position in string A
```

Complexity: O(m×n) where m, n — number of tokens.

### LogCluster Class

```javascript
class LogCluster {
  id: number           // Unique ID
  template: string     // Current pattern "INFO .* started"
  staticParts: string[] // Static parts ["INFO ", " started"]
  count: number        // Number of lines in cluster
  examples: string[]   // Up to 5 example lines
  timestamps: Date[]   // Timestamps (for timeline)

  tryAdd(line, threshold): boolean  // Attempt to add line
  similarity(line): number          // Calculate similarity
}
```

### LogClusterer Class

```javascript
class LogClusterer {
  threshold: number     // Minimum similarity (default 0.4)
  maxClusters: number   // Maximum clusters (default 10)
  clusters: LogCluster[]

  add(line, timestamp): number  // Add line, return cluster_id
  getCluster(id): LogCluster
  getStats(): ClusterStats[]
}
```

When maxClusters is exceeded — the smallest cluster is removed.

## Timestamp Module (timestamps.js)

### Supported Formats

| Format | Example | Regex |
|--------|---------|-------|
| ISO 8601 | `2024-01-15T10:30:00Z` | `\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}` |
| CLF | `[15/Jan/2024:10:30:00 +0000]` | `\[\d{2}/\w{3}/\d{4}:\d{2}:\d{2}:\d{2}` |
| Syslog | `Jan 15 10:30:00` | `\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}` |
| Simple | `2024-01-15 10:30:00` | `\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}` |
| Epoch ms | `1705315800000` | `1[4-9]\d{11}` |
| Epoch s | `1705315800` | `1[4-9]\d{8}` |

### Format Auto-detection

```javascript
detectTimestampFormat(sampleLines):
  1. For each pattern in TIMESTAMP_PATTERNS:
     - Count how many lines match
     - Verify that parse returns valid date
  2. Select pattern with confidence > 50%
  3. Return { pattern, confidence }
```

### Histograms

```javascript
calculateBucketSize(minDate, maxDate, targetBuckets=20):
  // Selects "nice" bucket size: second, minute, 5min, hour, day...

buildHistogram(timestamps, bucket):
  // Returns [{start, end, count}, ...]

formatHistogram(histogram, maxWidth=40):
  // ASCII visualization with █ and ░
```

## MCP Server (server.js)

### Caching

```javascript
const fileCache = new Map();
// key: "filepath:maxClusters:threshold:filter"
// value: { totalLines, clusterer, timestamps, timestampPattern }
```

Cache prevents re-reading the file during sequential calls to `log_cluster`, `log_timeline`, `log_cluster_drill`.

### Tool Handlers

#### log_overview
```
→ statSync for size
→ getOrCreateClustering for line count and time detection
← { file, size, total_lines, timestamp_format, time_range }
```

#### log_cluster
```
→ getOrCreateClustering with parameters
→ clusterer.getStats()
← { total_lines, cluster_count, clusters: [{id, count, percent, template, examples}] }
```

#### log_cluster_drill
```
→ Find parent cluster
→ Create new LogClusterer with threshold=0.5
→ Re-read file, adding only lines similar to parent
← { parent_cluster, subclusters: [...] }
```

#### log_timeline
```
→ getOrCreateClustering
→ If cluster_id specified — filter timestamps
→ calculateBucketSize + buildHistogram
→ Anomaly detection (> avg + 2σ)
← { bucket_size, histogram_ascii, anomalies }
```

#### log_grep
```
→ Iterate file with filter
→ Count matches, collect up to max_examples
← { total_matches, examples }  // NOT all lines!
```

#### log_fetch
```
→ Iterate file with filter, offset, limit
← { lines: [{line_num, line}, ...] }  // Raw data
```

## Typical Session Data Flow

```
1. LLM: log_overview("/var/log/app.log")
   ← "12M lines, 3 days, ISO8601 format"

2. LLM: log_cluster(file, max_clusters=8)
   [Clustering entire file, caching]
   ← 8 clusters with patterns and examples

3. LLM: log_timeline(file, cluster_id=5)
   [Uses cache, filters timestamps]
   ← Histogram, anomaly at 13:45

4. LLM: log_cluster_drill(file, cluster_id=5)
   [Re-reads file, sub-clustering]
   ← 4 subclusters within ERROR

5. LLM: log_grep(file, "connection refused")
   ← count=3500, 5 examples

6. LLM: log_fetch(file, filter="connection refused", limit=50)
   ← 50 raw lines for detailed analysis
```

## Extensibility

### Adding New Time Format
1. Add object to `TIMESTAMP_PATTERNS` in timestamps.js
2. Implement regex and parse function

### Adding New Tool
1. Add description to `TOOLS` in server.js
2. Implement `handleNewTool()`
3. Add case to handler switch

### Improving Clustering Algorithm
Main point — `findMatchingTokenBlocks()` function in clustering.js.
Can experiment with:
- Token weights (numbers vs words)
- Minimum block length
- Block selection strategy
