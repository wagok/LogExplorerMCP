# Log Explorer MCP

MCP server for intelligent log analysis with clustering.

## Idea

Logs are huge files that can't fit into LLM context. Traditional approach (grep) requires knowing what to search for. This tool solves the problem differently:

1. **Clustering** — automatic grouping of similar lines
2. **Lazy exploration** — statistics and examples first, details on demand
3. **LLM-driven drill-down** — LLM decides where to explore deeper
4. **Temporal analysis** — log dynamics, anomaly detection

## Quick Start

```bash
npm install
node test-cli.js /var/log/syslog
```

## Usage Scenario

```
LLM: "Analyze /var/log/app.log"

1. log_overview → "12M lines, 3 days, peak at 14:00 yesterday"

2. log_cluster →
   Cluster A: 68% - "INFO request completed..."
   Cluster B: 26% - "DEBUG cache hit/miss..."
   Cluster C: 4%  - "WARN connection timeout..."
   Cluster D: 2%  - "ERROR ..." ← interesting!

3. log_timeline(cluster_id=D) →
   "ERROR sharply increased from 100/hour to 5000/hour at 13:45"

4. log_cluster_drill(cluster_id=D) →
   D1: "ERROR database connection refused" (70%)
   D2: "ERROR null pointer in UserService" (20%)
   D3: "ERROR timeout calling payment API" (10%)

5. log_grep("database connection refused") →
   count: 3500, examples with context

6. log_fetch(...) → only when you need all lines
```

## Installation

```bash
git clone <repo>
cd log-explorer-mcp
npm install
```

## Usage

### As MCP Server

Add to your MCP client configuration:

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

### CLI for Testing

```bash
# Generate test logs
node generate-test-logs.cjs /tmp/test.log

# Analyze
node test-cli.js /tmp/test.log
```

## API Reference

### log_overview

Get general information about log file.

**Parameters:**
- `file` (string, required) — file path

**Response:**
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

Cluster log lines by similarity.

**Parameters:**
- `file` (string, required) — file path
- `max_clusters` (number, default: 10) — maximum clusters (2-20)
- `threshold` (number, default: 0.4) — similarity threshold (0.1-0.9)
- `filter` (string, optional) — line filter

**Response:**
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

Create subclusters within selected cluster.

**Parameters:**
- `file` (string, required)
- `cluster_id` (number, required) — cluster ID from log_cluster
- `max_subclusters` (number, default: 5)

### log_timeline

Get temporal histogram of logs.

**Parameters:**
- `file` (string, required)
- `cluster_id` (number, optional) — only for specific cluster
- `bucket_size` (string, default: "auto") — auto/minute/hour/day

**Response includes:**
- ASCII histogram
- Detected anomalies (spikes > 2σ)

### log_grep

Search by pattern with count and examples.

**Parameters:**
- `file` (string, required)
- `pattern` (string, required) — substring or `/regex/`
- `max_examples` (number, default: 5)
- `context_lines` (number, default: 0)

**Important:** Returns only count and examples, NOT all lines!

### log_fetch

Get raw lines (use when you know exactly what you need).

**Parameters:**
- `file` (string, required)
- `filter` (string, optional)
- `offset` (number, default: 0)
- `limit` (number, default: 100)

## Clustering Algorithm

Uses token-based similarity:

1. Lines are split into tokens (words, numbers, punctuation)
2. For two lines, find maximum matching token blocks
3. Form pattern with `.*` for differences
4. Similarity = 2 × matched / (len_a + len_b)

See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

## Project Files

```
├── CLAUDE.md          # Instructions for Claude Code
├── README.md          # This file
├── ARCHITECTURE.md    # Detailed architecture
├── package.json
├── server.js          # MCP server
├── clustering.js      # Clustering algorithm
├── timestamps.js      # Timestamp parsing
├── test-cli.js        # CLI for testing
└── generate-test-logs.cjs  # Test data generator
```

## License

MIT
