import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    from local_settings import (
        HOST as LOCAL_HOST,
        PORT as LOCAL_PORT,
        LLM_API_URL as LOCAL_LLM_API_URL,
        LLM_API_KEY as LOCAL_LLM_API_KEY,
        LLM_MODEL as LOCAL_LLM_MODEL,
        ALLOWED_ORIGIN as LOCAL_ALLOWED_ORIGIN,
        SUPABASE_URL as LOCAL_SUPABASE_URL,
        SUPABASE_SERVICE_ROLE_KEY as LOCAL_SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_TABLE as LOCAL_SUPABASE_TABLE,
    )
except ImportError:
    LOCAL_HOST = "0.0.0.0"
    LOCAL_PORT = 8000
    LOCAL_LLM_API_URL = "https://api.openai.com/v1/chat/completions"
    LOCAL_LLM_API_KEY = ""
    LOCAL_LLM_MODEL = "gpt-4o-mini"
    LOCAL_ALLOWED_ORIGIN = "http://localhost:5500"
    LOCAL_SUPABASE_URL = ""
    LOCAL_SUPABASE_SERVICE_ROLE_KEY = ""
    LOCAL_SUPABASE_TABLE = "weaklink_bottleneck_history"


HOST = os.getenv("WEAKLINK_BACKEND_HOST", LOCAL_HOST)
PORT = int(os.getenv("WEAKLINK_BACKEND_PORT", str(LOCAL_PORT)))
LLM_API_URL = os.getenv("LLM_API_URL", LOCAL_LLM_API_URL)
LLM_API_KEY = os.getenv("LLM_API_KEY", LOCAL_LLM_API_KEY)
LLM_MODEL = os.getenv("LLM_MODEL", LOCAL_LLM_MODEL)
ALLOWED_ORIGIN = os.getenv("WEAKLINK_ALLOWED_ORIGIN", LOCAL_ALLOWED_ORIGIN)
SUPABASE_URL = os.getenv("SUPABASE_URL", LOCAL_SUPABASE_URL).rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", LOCAL_SUPABASE_SERVICE_ROLE_KEY)
SUPABASE_TABLE = os.getenv("SUPABASE_TABLE", LOCAL_SUPABASE_TABLE)


def build_messages(question, analysis):
    system_prompt = (
        "You are WeakLink AI, a workflow bottleneck analysis assistant. "
        "Answer only from the provided process analysis. "
        "Be concise, practical, and business-friendly. "
        "If the data does not support a claim, say so clearly."
    )

    user_prompt = (
        f"User question: {question}\n\n"
        "Workflow analysis:\n"
        f"{json.dumps(analysis, indent=2)}\n\n"
        "Answer the question using this workflow analysis only."
    )

    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def call_llm(question, analysis):
    if not LLM_API_KEY:
        raise RuntimeError("Missing LLM_API_KEY environment variable.")

    payload = {
        "model": LLM_MODEL,
        "messages": build_messages(question, analysis),
        "temperature": 0.2,
    }

    request = Request(
        LLM_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {LLM_API_KEY}",
        },
        method="POST",
    )

    try:
        with urlopen(request, timeout=45) as response:
            body = json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        details = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"LLM API HTTP {err.code}: {details}") from err
    except URLError as err:
        raise RuntimeError(f"Could not reach LLM API: {err.reason}") from err

    choices = body.get("choices", [])
    if not choices:
        raise RuntimeError("LLM API returned no choices.")

    message = choices[0].get("message", {})
    content = message.get("content", "").strip()
    if not content:
        raise RuntimeError("LLM API returned an empty answer.")

    return content


def ensure_supabase_config():
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.")


def get_backend_status():
    return {
        "ok": True,
        "model": LLM_MODEL,
        "api_url": LLM_API_URL,
        "llm_configured": bool(LLM_API_KEY),
        "supabase_configured": bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY),
        "supabase_table": SUPABASE_TABLE,
    }


def supabase_request(method, path, payload=None):
    ensure_supabase_config()
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        f"{SUPABASE_URL}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Prefer": "return=representation",
        },
        method=method,
    )

    try:
        with urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8")
            return json.loads(body) if body else None
    except HTTPError as err:
        details = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Supabase HTTP {err.code}: {details}") from err
    except URLError as err:
        raise RuntimeError(f"Could not reach Supabase: {err.reason}") from err


def fetch_previous_snapshot():
    records = supabase_request(
        "GET",
        f"/rest/v1/{SUPABASE_TABLE}?select=*&order=created_at.desc&limit=1"
    ) or []
    return records[0] if records else None


def build_snapshot_record(analysis):
    bottleneck = analysis["bottleneck"]
    return {
        "bottleneck_step": bottleneck["step"],
        "bottleneck_score": bottleneck["score"],
        "source_row_count": analysis.get("sourceRowCount"),
        "process_count": analysis.get("processCount"),
        "analysis": analysis,
    }


def compare_snapshots(previous, current):
    if not previous:
        return {
            "message": (
                f"This is the first stored analysis. Current bottleneck is "
                f"{current['bottleneck']['step']} with score {current['bottleneck']['score']:.2f}."
            ),
            "type": "baseline",
        }

    previous_analysis = previous.get("analysis") or {}
    previous_bottleneck = previous_analysis.get("bottleneck") or {}
    previous_step = previous_bottleneck.get("step") or previous.get("bottleneck_step") or "Unknown"
    previous_score = float(previous_bottleneck.get("score") or previous.get("bottleneck_score") or 0)
    current_step = current["bottleneck"]["step"]
    current_score = float(current["bottleneck"]["score"])
    delta = current_score - previous_score

    if current_step != previous_step:
        message = (
            f"Bottleneck changed from {previous_step} ({previous_score:.2f}) "
            f"to {current_step} ({current_score:.2f}), a shift of {delta:+.2f}."
        )
        comparison_type = "changed"
    elif delta > 0:
        message = (
            f"{current_step} remains the bottleneck and has worsened by {delta:.2f} "
            f"compared with the previous upload."
        )
        comparison_type = "worse"
    elif delta < 0:
        message = (
            f"{current_step} remains the bottleneck but improved by {abs(delta):.2f} "
            f"compared with the previous upload."
        )
        comparison_type = "improved"
    else:
        message = (
            f"{current_step} remains the bottleneck with the same score as the previous upload "
            f"({current_score:.2f})."
        )
        comparison_type = "unchanged"

    return {
        "message": message,
        "type": comparison_type,
        "previous_step": previous_step,
        "previous_score": previous_score,
        "current_step": current_step,
        "current_score": current_score,
        "delta": delta,
        "previous_created_at": previous.get("created_at"),
    }


def save_snapshot_and_compare(analysis):
    previous = fetch_previous_snapshot()
    comparison = compare_snapshots(previous, analysis)
    inserted = supabase_request(
        "POST",
        f"/rest/v1/{SUPABASE_TABLE}",
        [build_snapshot_record(analysis)]
    )
    return {
        "saved": True,
        "comparison": comparison,
        "snapshot": inserted[0] if inserted else None,
    }


class WeakLinkHandler(BaseHTTPRequestHandler):
    def _send_json(self, status, payload):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(encoded)

    def do_OPTIONS(self):
        self._send_json(200, {"ok": True})

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, get_backend_status())
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_length)
            payload = json.loads(raw_body.decode("utf-8"))
            if self.path == "/api/chat":
                question = (payload.get("question") or "").strip()
                analysis = payload.get("analysis") or {}

                if not question:
                    self._send_json(400, {"error": "Missing question"})
                    return

                if not analysis:
                    self._send_json(400, {"error": "Missing analysis payload"})
                    return

                answer = call_llm(question, analysis)
                self._send_json(200, {"answer": answer})
                return

            if self.path == "/api/analysis-snapshots":
                analysis = payload.get("analysis") or {}
                if not analysis:
                    self._send_json(400, {"error": "Missing analysis payload"})
                    return

                result = save_snapshot_and_compare(analysis)
                self._send_json(200, result)
                return

            self._send_json(404, {"error": "Not found"})
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON body"})
        except Exception as err:
            self._send_json(500, {"error": str(err)})


if __name__ == "__main__":
    server = HTTPServer((HOST, PORT), WeakLinkHandler)
    print(f"WeakLink backend listening on http://{HOST}:{PORT}")
    server.serve_forever()
