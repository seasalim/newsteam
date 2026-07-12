#!/usr/bin/env python3
"""Web search handler using Brave Search API."""
import gzip
import json
import os
import sys
import urllib.request
import urllib.parse

args = json.load(sys.stdin)
query = args.get("query", "")
count = args.get("count", 3)

api_key = os.environ.get("BRAVE_API_KEY", "")
if not api_key:
    print(json.dumps({"error": "BRAVE_API_KEY not set"}))
    sys.exit(0)

url = f"https://api.search.brave.com/res/v1/web/search?q={urllib.parse.quote(query)}&count={count}"
req = urllib.request.Request(url, headers={
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "X-Subscription-Token": api_key,
})

try:
    with urllib.request.urlopen(req) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        data = json.loads(raw.decode("utf-8"))

    results = []
    for item in data.get("web", {}).get("results", [])[:count]:
        results.append({
            "title": item.get("title", ""),
            "url": item.get("url", ""),
            "snippet": item.get("description", ""),
        })

    print(json.dumps({"query": query, "results": results}, indent=2))

except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(0)
