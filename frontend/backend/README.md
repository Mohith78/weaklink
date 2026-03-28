# WeakLink Backend

This backend adds a real LLM-powered API for the `AI Chat` page.

## What It Does

- exposes `POST /api/chat`
- receives the user's question and current workflow analysis
- sends that context to an OpenAI-compatible LLM endpoint
- returns a grounded answer to the frontend chat

## Run It

### Option 1: Paste Keys Directly In Code

Open:

[`frontend/backend/local_settings.py`](c:/Users/mohit/Downloads/weaklink-main/frontend/backend/local_settings.py)

Fill in:

- `LLM_API_KEY`
- `LLM_API_URL`
- `LLM_MODEL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Then run:

```powershell
py frontend/backend/server.py
```

### Option 2: Environment Variables

In PowerShell:

```powershell
$env:LLM_API_KEY="your_api_key_here"
$env:LLM_MODEL="gpt-4o-mini"
py frontend/backend/server.py
```

The backend starts on:

```text
http://localhost:8000
```

Health check:

```text
http://localhost:8000/health
```

## Environment Variables

- `LLM_API_KEY`: required API key for the LLM provider
- `LLM_MODEL`: model name to use
- `LLM_API_URL`: optional, defaults to `https://api.openai.com/v1/chat/completions`
- `SUPABASE_URL`: your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY`: service role key used by the backend to write history rows
- `SUPABASE_TABLE`: optional, defaults to `weaklink_bottleneck_history`
- `WEAKLINK_BACKEND_HOST`: optional, defaults to `0.0.0.0`
- `WEAKLINK_BACKEND_PORT`: optional, defaults to `8000`
- `WEAKLINK_ALLOWED_ORIGIN`: optional, defaults to `http://localhost:5500`

## Frontend Behavior

The frontend sends:

- the user question
- bottleneck summary
- averages
- per-process scores

If the backend is unavailable, the UI falls back to the local rule-based answers so the chat still works in demo mode.

## Supabase Table

Create this table in Supabase before using history comparison:

```sql
create table if not exists public.weaklink_bottleneck_history (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  bottleneck_step text not null,
  bottleneck_score numeric not null,
  source_row_count integer,
  process_count integer,
  analysis jsonb not null
);
```

The backend will:

- fetch the latest previous row
- compare it with the current upload
- save the new analysis snapshot
- return a comparison message to the dashboard
