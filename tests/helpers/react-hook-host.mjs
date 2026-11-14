// Minimal test host for a component that returns null. React and ReactDOM are
// real; this shim does not claim to test DOM layout, events or browser rendering.
export async function hookHost() {
  const saved = new Map();
  function replace(key, value) { saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value }); }
  class Element {
    constructor(name, document) { this.nodeType = 1; this.nodeName = this.tagName = name.toUpperCase(); this.ownerDocument = document; this.namespaceURI = "http://www.w3.org/1999/xhtml"; this.children = []; this.style = {}; }
    addEventListener() {}
    removeEventListener() {}
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; }
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); child.parentNode = null; return child; }
    setAttribute() {}
    removeAttribute() {}
    get firstChild() { return this.children[0] || null; }
    get lastChild() { return this.children.at(-1) || null; }
  }
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {} };
  document.createElement = name => new Element(name, document);
  document.documentElement = document.createElement("html"); document.body = document.createElement("body"); document.activeElement = document.body;
  const window = { document, HTMLIFrameElement: class {}, HTMLElement: Element, addEventListener() {}, removeEventListener() {} }; document.defaultView = window;
  replace("window", window); replace("document", document); replace("IS_REACT_ACT_ENVIRONMENT", true);
  const { createRoot } = await import("react-dom/client");
  const { createElement, act } = await import("react");
  const root = createRoot(document.createElement("div"));
  return {
    act, createElement,
    async render(Component, props) { await act(async () => root.render(createElement(Component, props))); },
    async close() {
      await act(async () => root.unmount());
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    },
  };
}
