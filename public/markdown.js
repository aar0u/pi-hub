import { marked } from "./vendor/marked.esm.js";

const LANGUAGE_ALIASES = new Map([
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["jsx", "jsx"],
  ["py", "python"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["yml", "yaml"],
]);

const ALLOWED_TAGS = new Set([
  "A", "BLOCKQUOTE", "BR", "CODE", "DEL", "EM", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "LI", "OL", "P", "PRE", "SPAN", "STRONG", "TABLE", "TBODY", "TD", "TH", "THEAD", "TR", "UL",
]);
const ALLOWED_ATTRS = new Map([
  ["A", new Set(["href", "title", "target", "rel"])],
  ["CODE", new Set(["class"])],
  ["PRE", new Set(["class", "data-lang"])],
  ["SPAN", new Set(["class"])],
  ["TH", new Set(["align"])],
  ["TD", new Set(["align"])],
]);

function normalizeLanguage(value = "") {
  const language = value.trim().split(/\s+/)[0].toLowerCase();
  return LANGUAGE_ALIASES.get(language) || language;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHref(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

export function sanitizeNode(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === Node.COMMENT_NODE) {
      child.remove();
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    if (!ALLOWED_TAGS.has(child.tagName)) {
      child.replaceWith(...child.childNodes);
      sanitizeNode(node);
      return;
    }

    const allowed = ALLOWED_ATTRS.get(child.tagName) || new Set();
    for (const attr of [...child.attributes]) {
      if (!allowed.has(attr.name)) child.removeAttribute(attr.name);
    }
    if (child.tagName === "A") {
      const href = safeHref(child.getAttribute("href") || "");
      if (href) {
        child.href = href;
        child.target = "_blank";
        child.rel = "noreferrer";
      } else {
        child.removeAttribute("href");
      }
    }
    if ((child.tagName === "TH" || child.tagName === "TD") && child.getAttribute("align")) {
      const align = child.getAttribute("align").toLowerCase();
      if (!["left", "center", "right"].includes(align)) child.removeAttribute("align");
    }
    sanitizeNode(child);
  }
}

function highlightCode(source, language) {
  const Prism = window.Prism;
  if (!Prism || !language || !Prism.languages[language]) return escapeHtml(source);
  return Prism.highlight(source, Prism.languages[language], language);
}

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }) => {
  const language = normalizeLanguage(lang);
  const label = language ? ` data-lang="${escapeHtml(language)}"` : "";
  const className = language ? ` class="code-block language-${escapeHtml(language)}"` : ' class="code-block"';
  const codeClass = language ? ` class="language-${escapeHtml(language)}"` : "";
  return `<pre${className}${label}><code${codeClass}>${highlightCode(text, language)}</code></pre>`;
};
renderer.codespan = ({ text }) => `<code class="inline-code">${escapeHtml(text)}</code>`;
renderer.link = function ({ href, title, tokens }) {
  const safe = safeHref(href);
  const text = this.parser.parseInline(tokens);
  if (!safe) return text;
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(safe)}"${titleAttr} target="_blank" rel="noreferrer">${text}</a>`;
};

marked.use({
  renderer,
  gfm: true,
  breaks: true,
});

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall back for browsers/hosts where Clipboard API is present but denied.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function addCodeControls(container) {
  for (const pre of container.querySelectorAll("pre.code-block")) {
    if (pre.querySelector(".code-copy")) continue;
    const language = pre.dataset.lang;
    if (language) {
      const lang = document.createElement("span");
      lang.className = "code-lang";
      lang.textContent = language;
      pre.append(lang);
    }
    const copy = document.createElement("button");
    copy.className = "code-copy";
    copy.type = "button";
    copy.textContent = "Copy";
    copy.onclick = async () => {
      const text = pre.querySelector("code")?.textContent || "";
      copy.textContent = await copyText(text) ? "Copied!" : "Copy failed";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    };
    pre.append(copy);
  }
}

export function renderMarkdown(text, container) {
  const html = marked.parse(text || "");
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeNode(template.content);
  container.append(template.content);
  addCodeControls(container);
}
