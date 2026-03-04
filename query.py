#!/usr/bin/env python3
"""Query a Gemini File Search store.

Usage:
  query.py "your question"
  query.py "your question" --domain openclaw
  query.py "your question" --domain gemini --model gemini-2.5-flash
"""
import os, sys, json, time
from google import genai
from google.genai import types

API_KEY = os.environ.get('GOOGLE_API_KEY')
STORE = os.environ.get('STORE_ID', '')
METRICS_FILE = os.environ.get('METRICS_FILE', 'metrics.jsonl')

DOMAIN_PREFIXES = {
    "youtube": "[YOUTUBE]",
    "gemini": "[GEMINI API]",
    "discord": "[DISCORD API]",
    "claude": "[CLAUDE API]",
    "openclaw": "[OPENCLAW]",
    "github": "[GITHUB]",
}

def parse_args():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(1)
    query = args[0]
    model = "gemini-3-flash-preview"
    domain = None
    i = 1
    while i < len(args):
        if args[i] == "--model" and i + 1 < len(args):
            model = args[i + 1]; i += 2
        elif args[i] == "--domain" and i + 1 < len(args):
            domain = args[i + 1].lower(); i += 2
        else:
            i += 1
    return query, model, domain

def log_metric(query, domain, model, elapsed_s, success):
    entry = {
        "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "query": query[:200],
        "domain": domain,
        "model": model,
        "elapsed_s": round(elapsed_s, 2),
        "success": success,
    }
    try:
        with open(METRICS_FILE, "a") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass

if not API_KEY:
    print("ERROR: GOOGLE_API_KEY not set", file=sys.stderr)
    sys.exit(1)

if not STORE:
    print("ERROR: STORE_ID not set", file=sys.stderr)
    sys.exit(1)

query, model, domain = parse_args()

effective_query = query
if domain and domain in DOMAIN_PREFIXES:
    effective_query = f"{DOMAIN_PREFIXES[domain]} {query}"

client = genai.Client(api_key=API_KEY)

t0 = time.time()
try:
    response = client.models.generate_content(
        model=model,
        contents=effective_query,
        config=types.GenerateContentConfig(
            tools=[
                types.Tool(
                    file_search=types.FileSearch(
                        file_search_store_names=[STORE]
                    )
                )
            ]
        )
    )
    elapsed = time.time() - t0
    log_metric(query, domain, model, elapsed, True)
    print(response.text)
except Exception as e:
    elapsed = time.time() - t0
    log_metric(query, domain, model, elapsed, False)
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
