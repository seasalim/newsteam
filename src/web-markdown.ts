/** Browser-safe Markdown subset used by the local chat page. */
export const WEB_MARKDOWN_SCRIPT = String.raw`
function escapeMarkdownHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderMarkdownInline(value) {
  var code = [];
  var rendered = value.replace(/\x60([^\x60\n]+)\x60/g, function (_match, body) {
    var token = '\x00CODE' + code.length + '\x00';
    code.push('<code>' + body + '</code>');
    return token;
  });
  rendered = rendered.replace(/\[([^\]]+)\]\((https?:\/\/[^\s<>"']+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  rendered = rendered.replace(/\x00CODE(\d+)\x00/g, function (_match, index) {
    return code[Number(index)] || '';
  });
  return rendered;
}

function renderMarkdown(value) {
  var escaped = escapeMarkdownHtml(value).replace(/\r\n?/g, '\n');
  var lines = escaped.split('\n');
  var output = [];
  var paragraph = [];
  var listType = '';
  var inCode = false;
  var codeLines = [];

  function flushParagraph() {
    if (paragraph.length) output.push('<p>' + renderMarkdownInline(paragraph.join(' ')) + '</p>');
    paragraph = [];
  }
  function closeList() {
    if (listType) output.push('</' + listType + '>');
    listType = '';
  }
  function openList(type) {
    if (listType === type) return;
    closeList();
    listType = type;
    output.push('<' + type + '>');
  }

  lines.forEach(function (line) {
    if (/^\x60\x60\x60/.test(line)) {
      flushParagraph(); closeList();
      if (inCode) {
        output.push('<pre><code>' + codeLines.join('\n') + '</code></pre>');
        codeLines = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) { codeLines.push(line); return; }
    if (!line.trim()) { flushParagraph(); closeList(); return; }
    var heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); closeList();
      var level = heading[1].length;
      output.push('<h' + level + '>' + renderMarkdownInline(heading[2]) + '</h' + level + '>');
      return;
    }
    var unordered = /^\s*[-*]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph(); openList('ul');
      output.push('<li>' + renderMarkdownInline(unordered[1]) + '</li>');
      return;
    }
    var ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph(); openList('ol');
      output.push('<li>' + renderMarkdownInline(ordered[1]) + '</li>');
      return;
    }
    var quote = /^&gt;\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph(); closeList();
      output.push('<blockquote>' + renderMarkdownInline(quote[1]) + '</blockquote>');
      return;
    }
    closeList();
    paragraph.push(line.trim());
  });
  if (inCode) output.push('<pre><code>' + codeLines.join('\n') + '</code></pre>');
  flushParagraph(); closeList();
  return output.join('');
}
`;
