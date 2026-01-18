# CLAUDE.md - Instructions for Claude Code

## Language Policy

- **Documentation and code comments**: English only
- **Communication with user**: Russian (по-русски)

## Project Overview

**Log Explorer MCP** is an MCP server for intelligent log analysis through LLM. Key idea: logs are too large for LLM context, so we use clustering for information compression and lazy exploration for gradual drill-down into details.

## Concept

### Problem
- Logs contain millions of lines — don't fit in context
- Grep requires knowing what to search for in advance
- Log format is unknown until analysis

### Solution
1. **Similarity clustering** — group similar lines, extract patterns
2. **Lazy exploration** — statistics and examples first, details on demand
3. **LLM-driven drill-down** — LLM decides where to explore deeper
4. **Temporal analysis** — log dynamics, anomaly detection

### Similarity Algorithm (Key Innovation)

Token-based pattern extraction:
```
"User john logged in from 192.168.1.1"
"User admin logged in from 10.0.0.5"
         ↓
"User .* logged in from .*"
```

Algorithm in `clustering.js`:
1. Tokenization (words, numbers, punctuation separately)
2. LCS at token level (not characters!)
3. Greedy selection of non-overlapping blocks
4. Pattern formation with `.*` for differences
5. Similarity = 2 × matched_len / (len_a + len_b)

## Project Structure

```
log-explorer-mcp/
├── CLAUDE.md          # This file - instructions for Claude Code
├── README.md          # User documentation
├── ARCHITECTURE.md    # Detailed architecture
├── package.json       # Node.js configuration (ESM)
├── server.js          # MCP server - entry point
├── clustering.js      # Clustering algorithm
├── timestamps.js      # Timestamp parsing
├── test-cli.js        # CLI for testing without MCP
└── generate-test-logs.cjs  # Test data generator
```

## How to Run

```bash
# Install dependencies
npm install

# Test CLI (without MCP)
node generate-test-logs.cjs /tmp/test.log
node test-cli.js /tmp/test.log

# Run MCP server
node server.js
```

## MCP Tools (API)

| Tool | Purpose | When to Use |
|------|---------|-------------|
| `log_overview` | General file information | First step of analysis |
| `log_cluster` | Clustering with patterns | Understand log structure |
| `log_cluster_drill` | Subclusters within cluster | Dive into interesting cluster |
| `log_timeline` | Temporal histogram | Find anomalies over time |
| `log_grep` | Search (count + examples) | Verify hypothesis |
| `log_fetch` | Raw lines | When you know exactly what you need |

## Development Principles

1. **Lazy by default** — minimum data at each step
2. **Statistics first** — count/histogram first, then examples
3. **No Python** — project is Node.js (owner preference)
4. **Algorithm simplicity** — no ML/embeddings, pure algorithms

## Current State

✅ Implemented:
- Basic clustering with pattern extraction
- Timestamp parsing (multiple formats)
- Temporal histograms with anomaly detection
- MCP server with all tools
- CLI for testing

⚠️ Needs improvement:
- See `bd ready` for task list

## Development Commands

```bash
# Test clustering on real logs
node test-cli.js /var/log/syslog

# Generate logs with anomalies
node generate-test-logs.cjs /tmp/anomaly.log

# Test MCP protocol (stdin/stdout)
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node server.js
```

## Creation Context

Project created in a dialogue about log analysis through LLM. Original idea: log clustering allows LLM to understand structure without reading all lines, then interactively "dive" into interesting clusters.

Inspiration: Drain algorithm for log parsing, but focused on interactive exploration instead of batch processing.
