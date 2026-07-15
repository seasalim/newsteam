#!/usr/bin/env python3
"""Web fetch handler. Retrieves a URL and extracts readable text content."""
import gzip
import html
import json
import re
import sys
import urllib.request


def strip_html(raw_html: str) -> str:
    """Naive but effective HTML-to-text: strip tags, decode entities, collapse whitespace."""
    # Remove script/style blocks entirely
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)
    # Replace block elements with newlines
    text = re.sub(r"<(br|p|div|h[1-6]|li|tr|blockquote)[^>]*>", "\n", text, flags=re.IGNORECASE)
    # Strip all remaining tags
    text = re.sub(r"<[^>]+>", "", text)
    # Decode HTML entities
    text = html.unescape(text)
    # Collapse whitespace: multiple spaces to one, preserve newlines
    text = re.sub(r"[^\S\n]+", " ", text)
    # Collapse multiple blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_title(raw_html: str) -> str:
    """Pull <title> content if present."""
    match = re.search(r"<title[^>]*>(.*?)</title>", raw_html, re.DOTALL | re.IGNORECASE)
    if match:
        return html.unescape(match.group(1)).strip()
    return ""


args = json.load(sys.stdin)
url = args.get("url", "")
max_chars = min(int(args.get("max_chars", 4000)), 8000)

if not url:
    print(json.dumps({"error": "url is required"}))
    sys.exit(0)

if not url.startswith(("http://", "https://")):
    print(json.dumps({"error": "Only http and https URLs are supported"}))
    sys.exit(0)

headers = {
    "User-Agent": "Mozilla/5.0 (compatible; NewsTeam/1.0; +https://github.com/seasalim/newsteam)",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip",
}

try:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=8) as resp:
        raw = resp.read()
        if resp.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)

        content_type = resp.headers.get("Content-Type", "")
        # Detect charset
        charset = "utf-8"
        if "charset=" in content_type:
            charset = content_type.split("charset=")[-1].split(";")[0].strip()

        decoded = raw.decode(charset, errors="replace")

    # If it looks like HTML, extract text
    if "<html" in decoded[:1000].lower() or "<body" in decoded[:2000].lower():
        title = extract_title(decoded)
        text = strip_html(decoded)
    else:
        # Plain text or other — return as-is
        title = ""
        text = decoded

    # Truncate
    if len(text) > max_chars:
        text = text[:max_chars] + "\n... (truncated)"

    result = {"url": url, "content": text}
    if title:
        result["title"] = title

    print(json.dumps(result))

except Exception as e:
    print(json.dumps({"error": str(e), "url": url}))
    sys.exit(0)
