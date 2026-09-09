export const MESSAGE_PAGE_SIZE = 160;

export function createMessageWindow(size = MESSAGE_PAGE_SIZE) {
  let anchor = null;
  return {
    page(messages) {
      const latest = Math.max(0, messages.length - size);
      const found = anchor == null ? latest : messages.findIndex((message) => message.key === anchor);
      const start = found < 0 ? 0 : Math.min(latest, found);
      return { visible: messages.slice(start, start + size), before: start, after: Math.max(0, messages.length - start - size), start, total: messages.length };
    },
    move(messages, direction) {
      if (direction === "latest") { anchor = null; return; }
      const page = this.page(messages);
      const next = Math.max(0, Math.min(messages.length - size, page.start + (direction === "earlier" ? -size : size)));
      anchor = messages[next]?.key || null;
    },
    freeze(messages) { if (anchor == null) anchor = this.page(messages).visible[0]?.key || null; },
  };
}

// Markup is supplied only by the existing escaped/sanitized message renderers.
// Unchanged top-level nodes keep identity, open details and focus on stream updates.
export function reconcileMessageMarkup(root, markup) {
  if (root.__messageMarkup === markup) return false;
  const fragment = root.ownerDocument.createRange().createContextualFragment(markup);
  const keyFor = (node, index) => node.nodeType !== 1 ? `text:${index}` : (node.hasAttribute("data-ask-id") ? `ask:${node.getAttribute("data-run-id")}:${node.getAttribute("data-ask-id")}` : "")
    || node.getAttribute("data-approval-id") || node.getAttribute("data-bot-event-key") || node.getAttribute("data-stream-key")
    || node.getAttribute("data-bot-conversation") || node.getAttribute("data-bot-project-node") || node.getAttribute("data-bot-tree-section")
    || node.id || `${node.tagName}:${node.getAttribute("class") || ""}:${index}`;
  function reconcile(parent, freshParent) {
    const current = new Map([...parent.childNodes].map((node, index) => [keyFor(node, index), node]));
    let cursor = parent.firstChild;
    for (const [index, fresh] of [...freshParent.childNodes].entries()) {
      const key = keyFor(fresh, index);
      const old = current.get(key);
      const source = fresh.nodeType === 1 ? fresh.outerHTML : fresh.nodeValue;
      let node = fresh;
      if (old && old.nodeType === fresh.nodeType && old.nodeName === fresh.nodeName) {
        current.delete(key);
        node = old;
        if (old.__sourceMarkup !== source && !old.isEqualNode(fresh)) {
          if (old.nodeType === 1) {
            for (const attribute of [...old.attributes]) {
              if (!fresh.hasAttribute(attribute.name) && !(old.tagName === "DETAILS" && attribute.name === "open")) old.removeAttribute(attribute.name);
            }
            for (const attribute of fresh.attributes) if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
            reconcile(old, fresh);
          } else old.nodeValue = fresh.nodeValue;
        }
      }
      node.__sourceMarkup = source;
      if (node !== cursor) parent.insertBefore(node, cursor);
      cursor = node.nextSibling;
    }
    for (const node of current.values()) node.remove();
  }
  reconcile(root, fragment);
  root.__messageMarkup = markup;
  return true;
}
