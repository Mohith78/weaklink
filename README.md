# WeakLink

WeakLink is a workflow bottleneck analysis platform that helps teams identify the process step causing the highest delay across uploaded operational data.

## Problem Statement

Organizations often run multi-step workflows such as onboarding, approvals, logistics, verification, delivery, or internal operations.  
When delays happen, teams usually know that the process is slow, but they do not know exactly which step is responsible at scale.

Traditional analysis creates two problems:

- one extreme case can distort the conclusion
- manual analysis across many rows is slow and hard to explain

The real need is to detect the bottleneck based on the majority pattern across all uploaded records, not on a single outlier.

## Solution

WeakLink solves this by turning raw CSV or Google Sheets workflow data into actionable bottleneck intelligence.

### How it works

1. Upload workflow data from CSV or Google Sheets
2. Group all records by process step
3. Compute average time, failure, and dependency values for each process
4. Calculate a bottleneck score for every process
5. Highlight the primary bottleneck and near-risk steps
6. Generate recommendations for operational improvement
7. Compare the current upload with previously stored analyses using Supabase
8. Answer natural-language questions through AI Chat using a real LLM backend

### Key Features

- Bottleneck detection based on aggregated process behavior
- Dashboard for score visualization and risk ranking
- Simulation page for testing changes before rollout
- Insights page for process analysis
- Recommendations page for improvement actions
- AI Chat for natural-language workflow analysis
- Supabase-based history comparison across uploads

## Tech Stack

### Frontend

- HTML
- CSS
- Vanilla JavaScript (ES modules)

### Backend

- Python
- Built-in `http.server` style backend using `BaseHTTPRequestHandler`

### Data Sources

- CSV uploads
- Google Sheets CSV export links

### AI / Analytics

- OpenAI-compatible LLM API integration
- Local workflow analysis and bottleneck scoring engine

### Database

- Supabase

### Local Development

- Python `http.server` for frontend hosting
- Python backend server for AI chat and Supabase persistence

## Project Structure

```text
frontend/
  app.js
  config.js
  index.html
  style.css
  utils.js
  backend/
    server.py
    README.md
    local_settings.example.py
package.json
sample_data.csv
```

## Run Locally

### Frontend

```powershell
py -m http.server 5500 --directory frontend
```

### Backend

Fill your keys in:

[`frontend/backend/local_settings.py`](frontend/backend/local_settings.example.py)

Then run:

```powershell
py frontend/backend/server.py
```

## Why WeakLink Matters

WeakLink helps organizations move from raw workflow data to clear operational decisions.

Instead of asking:

- Which individual case failed?

it answers:

- Which process is consistently slowing down the system for the majority of users?

That makes the output more actionable, more scalable, and easier to present to decision-makers.
