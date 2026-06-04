import { sanitizeNode } from "../public/markdown.js";

globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, COMMENT_NODE: 8 };
globalThis.window = { location: { href: "http://localhost/" } };

class FakeText {
  constructor(text) {
    this.nodeType = Node.TEXT_NODE;
    this.textContent = text;
    this.parentNode = null;
  }
}

class FakeComment {
  constructor() {
    this.nodeType = Node.COMMENT_NODE;
    this.parentNode = null;
  }

  remove() {
    removeChild(this);
  }
}

class FakeElement {
  constructor(tagName, attrs = {}, children = []) {
    this.nodeType = Node.ELEMENT_NODE;
    this.tagName = tagName.toUpperCase();
    this._attrs = new Map(Object.entries(attrs));
    this.childNodes = [];
    this.parentNode = null;
    for (const child of children) this.append(child);
  }

  get attributes() {
    return [...this._attrs.keys()].map((name) => ({ name }));
  }

  append(child) {
    child.parentNode = this;
    this.childNodes.push(child);
  }

  getAttribute(name) {
    return this._attrs.get(name) ?? null;
  }

  setAttribute(name, value) {
    this._attrs.set(name, String(value));
  }

  removeAttribute(name) {
    this._attrs.delete(name);
  }

  remove() {
    removeChild(this);
  }

  replaceWith(...nodes) {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.childNodes.indexOf(this);
    if (index === -1) return;
    for (const node of nodes) node.parentNode = parent;
    parent.childNodes.splice(index, 1, ...nodes);
    this.parentNode = null;
  }

  set href(value) {
    this.setAttribute("href", value);
  }

  set target(value) {
    this.setAttribute("target", value);
  }

  set rel(value) {
    this.setAttribute("rel", value);
  }
}

function removeChild(node) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index !== -1) parent.childNodes.splice(index, 1);
  node.parentNode = null;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function tags(node) {
  return node.childNodes.filter((child) => child.nodeType === Node.ELEMENT_NODE).map((child) => child.tagName);
}

const root = new FakeElement("root", {}, [
  new FakeComment(),
  new FakeElement("script", {}, [new FakeElement("span", { onclick: "alert(1)", class: "x" }, [new FakeText("bad")])]),
  new FakeElement("a", { href: "javascript:alert(1)", onclick: "alert(1)" }, [new FakeText("bad link")]),
  new FakeElement("a", { href: "/ok", title: "ok" }, [new FakeText("good link")]),
  new FakeElement("td", { align: "expression(alert(1))" }, [new FakeText("bad align")]),
  new FakeElement("th", { align: "center" }, [new FakeText("good align")]),
]);

sanitizeNode(root);

assert(!tags(root).includes("SCRIPT"), "disallowed tags should be unwrapped");
assert(root.childNodes.every((child) => child.nodeType !== Node.COMMENT_NODE), "comments should be removed");

const span = root.childNodes.find((child) => child.tagName === "SPAN");
assert(span?.getAttribute("onclick") === null, "event handler attributes should be removed");

const links = root.childNodes.filter((child) => child.tagName === "A");
assert(links[0].getAttribute("href") === null, "unsafe href should be removed");
assert(links[0].getAttribute("onclick") === null, "link event handler should be removed");
assert(links[1].getAttribute("href") === "http://localhost/ok", "safe relative href should be normalized");
assert(links[1].getAttribute("target") === "_blank", "safe links should open in a new tab");
assert(links[1].getAttribute("rel") === "noreferrer", "safe links should set rel");

const cells = root.childNodes.filter((child) => child.tagName === "TD" || child.tagName === "TH");
assert(cells[0].getAttribute("align") === null, "unsafe table alignment should be removed");
assert(cells[1].getAttribute("align") === "center", "safe table alignment should be preserved");

console.log("Markdown sanitizer checks passed.");
