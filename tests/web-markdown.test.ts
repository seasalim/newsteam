import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { LOCAL_CHANNEL_PAGE } from "../src/local-channel-page.ts";
import { WEB_MARKDOWN_SCRIPT } from "../src/web-markdown.ts";
import { HTML_PAGE } from "../src/dashboard-page.ts";

function render(input: string): string {
  const context = { input, result: "" };
  vm.runInNewContext(`${WEB_MARKDOWN_SCRIPT}\nresult = renderMarkdown(input);`, context);
  return context.result;
}

test("web Markdown renderer supports the digest subset", () => {
  const output = render("## Briefing\n\n**Strong** and *emphasis* with `code`.\n\n- one\n- two\n\n> quote\n\n[Source](https://example.com/story)");
  assert.match(output, /<h2>Briefing<\/h2>/u);
  assert.match(output, /<strong>Strong<\/strong>/u);
  assert.match(output, /<em>emphasis<\/em>/u);
  assert.match(output, /<code>code<\/code>/u);
  assert.match(output, /<ul><li>one<\/li><li>two<\/li><\/ul>/u);
  assert.match(output, /rel="noopener noreferrer"/u);
});

test("web Markdown renderer escapes model HTML and rejects unsafe links", () => {
  const output = render("<img src=x onerror=alert(1)> [bad](javascript:alert(1))\n\n```html\n<script>alert(1)</script>\n```");
  assert.doesNotMatch(output, /<img/u);
  assert.doesNotMatch(output, /<script>/u);
  assert.doesNotMatch(output, /href="javascript:/u);
  assert.match(output, /&lt;img/u);
  assert.match(output, /&lt;script&gt;/u);
});

test("local chat page is self-contained and includes the required controls", () => {
  assert.match(LOCAL_CHANNEL_PAGE, /id="channels"/u);
  assert.match(LOCAL_CHANNEL_PAGE, /id="composer"/u);
  assert.match(LOCAL_CHANNEL_PAGE, /id="new-button"/u);
  assert.match(LOCAL_CHANNEL_PAGE, /profile_image_url/u);
  assert.match(LOCAL_CHANNEL_PAGE, /loading='lazy'|loading="lazy"/u);
  assert.match(LOCAL_CHANNEL_PAGE, /image\.onerror=function\(\)\{image\.remove\(\)\}/u);
  assert.match(LOCAL_CHANNEL_PAGE, /new EventSource\('\/api\/chat\/events'\)/u);
  assert.match(LOCAL_CHANNEL_PAGE, /source\.onopen=function\(\)/u);
  assert.match(LOCAL_CHANNEL_PAGE, /status\.textContent==='Reconnecting to local chat…'/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /<script\s+src=/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /<link[^>]+stylesheet/u);
});

test("local chat constrains the message grid row so the stream scrolls", () => {
  assert.match(LOCAL_CHANNEL_PAGE, /grid-template-rows:auto minmax\(0,1fr\) auto/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.stream\{min-height:0;overflow-y:auto/u);
});

test("local chat emphasizes a single rail avatar over channel identifiers", () => {
  assert.match(LOCAL_CHANNEL_PAGE, /\.rail-avatar\{width:72px;height:72px/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.agent-label\{text-align:center\}/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.agent-label:not\(:first-child\)\{border-top:1px solid var\(--border\)/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.rail\{scrollbar-width:none\}/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.rail::-webkit-scrollbar\{display:none\}/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.channel\{position:relative;flex-direction:column/u);
  assert.match(LOCAL_CHANNEL_PAGE, /class="header-channel" id="header-channel"/u);
  assert.match(LOCAL_CHANNEL_PAGE, /button\.append\(profileElement\(channel,'rail-avatar'\),id\)/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /News feed|badge\.textContent='FEED'|function channelLabel/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /id="header-profile"/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /profileElement\(channel,'header-avatar'\)/u);
  assert.doesNotMatch(LOCAL_CHANNEL_PAGE, /profileElement\(state\.active,'message-avatar'\)/u);
  assert.match(LOCAL_CHANNEL_PAGE, /\.message\.agent\{display:block\}/u);
});

test("dashboard controls use a non-floating responsive header", () => {
  assert.match(HTML_PAGE, /\.page-header\s*\{[^}]*display: flex;/u);
  assert.match(HTML_PAGE, /\.header-actions\s*\{[^}]*display: flex;[^}]*gap: 8px;/u);
  assert.match(HTML_PAGE, /<div class="page-header">/u);
  assert.doesNotMatch(HTML_PAGE, /position: fixed/u);
  assert.match(HTML_PAGE, /function profileMarkup\(id, url\)/u);
  assert.match(HTML_PAGE, /class="agent-heading"/u);
  assert.match(HTML_PAGE, /loading="lazy"/u);
});
