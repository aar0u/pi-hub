export function renderMarkdown(text, container) {
  const value = text || "";
  const re = /```([^\n`]*)\n([\s\S]*?)```/g;
  let last = 0;
  let match;
  while ((match = re.exec(value))) {
    if (match.index > last) renderMarkdownBlocks(value.slice(last, match.index), container);
    renderCodeBlock(match[2], match[1]?.trim(), container);
    last = match.index + match[0].length;
  }
  if (last < value.length) renderMarkdownBlocks(value.slice(last), container);
}

function renderCodeBlock(source, language, container) {
  const pre = document.createElement("pre");
  pre.className = "code-block";
  const code = document.createElement("code");
  code.textContent = source;
  if (language) code.className = `language-${language}`;
  if (window.hljs) window.hljs.highlightElement(code);
  pre.append(code);
  if (language) {
    const lang = document.createElement("span");
    lang.className = "code-lang";
    lang.textContent = language;
    pre.append(lang);
  }
  const copy = document.createElement("button");
  copy.className = "code-copy";
  copy.textContent = "Copy";
  copy.onclick = () => {
    navigator.clipboard.writeText(code.textContent);
    copy.textContent = "Copied!";
    setTimeout(() => (copy.textContent = "Copy"), 1500);
  };
  pre.append(copy);
  container.append(pre);
}

function renderMarkdownBlocks(text, container) {
  const lines = (text || "").replace(/^\n+|\n+$/g, "").split("\n");
  let paragraph = [];
  let list = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement("p");
    renderInlineMarkdown(paragraph.join("\n"), p);
    container.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    container.append(list);
    list = null;
  };

  for (const line of lines) {
    const item = line.match(/^\s*[-*]\s+(.+)$/);
    if (item) {
      flushParagraph();
      if (!list) list = document.createElement("ul");
      const li = document.createElement("li");
      renderInlineMarkdown(item[1], li);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
}

function renderInlineMarkdown(text, container) {
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let match;
  while ((match = re.exec(text || ""))) {
    if (match.index > last) container.append(new Text(text.slice(last, match.index)));
    if (match[2]) {
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      container.append(strong);
    } else if (match[3]) {
      const code = document.createElement("code");
      code.className = "inline-code";
      code.textContent = match[3];
      container.append(code);
    } else {
      const href = safeHref(match[5]);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = match[4];
        container.append(link);
      } else {
        container.append(new Text(match[0]));
      }
    }
    last = match.index + match[0].length;
  }
  if (last < (text || "").length) container.append(new Text(text.slice(last)));
}

function safeHref(value) {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
