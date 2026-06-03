export const $ = (id) => document.getElementById(id);

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

export function setIcon(el, name) {
  const use = el.querySelector("use");
  if (use) use.setAttribute("href", `#icon-${name}`);
}

export function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}m${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

export function compactText(text, max = 120) {
  const value = (text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
