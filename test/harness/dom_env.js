const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '../..');

function createClock(initialTime = 1700000000000) {
  let currentTime = initialTime;
  let nextTimerId = 1;
  const timers = new Map();
  const rafCallbacks = new Map();
  let nextRafId = 1;

  function setTimeout(fn, delay = 0, ...args) {
    const id = nextTimerId++;
    timers.set(id, {
      fn: () => fn(...args),
      time: currentTime + Math.max(0, delay),
      type: 'timeout'
    });
    return id;
  }

  function clearTimeout(id) {
    timers.delete(id);
  }

  function setInterval(fn, period = 0, ...args) {
    const id = nextTimerId++;
    timers.set(id, {
      fn: () => fn(...args),
      time: currentTime + Math.max(1, period),
      period: Math.max(1, period),
      type: 'interval'
    });
    return id;
  }

  function clearInterval(id) {
    timers.delete(id);
  }

  function requestAnimationFrame(fn) {
    const id = nextRafId++;
    rafCallbacks.set(id, fn);
    return id;
  }

  function cancelAnimationFrame(id) {
    rafCallbacks.delete(id);
  }

  class VirtualDate {
    constructor(...args) {
      if (args.length === 0) this._time = currentTime;
      else if (args.length === 1) this._time = new Date(args[0]).getTime();
      else this._time = new Date(...args).getTime();
    }
    getTime() { return this._time; }
    toISOString() { return new Date(this._time).toISOString(); }
    toString() { return new Date(this._time).toString(); }
    toUTCString() { return new Date(this._time).toUTCString(); }
    valueOf() { return this._time; }
    static now() { return currentTime; }
  }

  async function flush() {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  async function tick(ms) {
    const targetTime = currentTime + ms;
    while (true) {
      let earliestId = null;
      let earliestTime = Infinity;
      for (const [id, t] of timers.entries()) {
        if (t.time <= targetTime && t.time < earliestTime) {
          earliestTime = t.time;
          earliestId = id;
        }
      }
      if (earliestId === null) break;
      const t = timers.get(earliestId);
      currentTime = t.time;
      if (t.type === 'timeout') {
        timers.delete(earliestId);
      } else {
        t.time = currentTime + t.period;
      }
      try {
        t.fn();
      } catch (err) {
        console.error('Timer error:', err);
      }
      await flush();
    }
    currentTime = targetTime;
    await flush();
  }

  async function runRafFrames(count = 1, deltaMs = 16.66) {
    for (let i = 0; i < count; i++) {
      const cbs = Array.from(rafCallbacks.values());
      rafCallbacks.clear();
      currentTime += deltaMs;
      for (const cb of cbs) {
        try {
          cb(currentTime);
        } catch (err) {
          console.error('RAF error:', err);
        }
      }
      await flush();
    }
  }

  function clearAll() {
    timers.clear();
    rafCallbacks.clear();
  }

  return {
    now: () => currentTime,
    Date: VirtualDate,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame,
    cancelAnimationFrame,
    tick,
    runRafFrames,
    flush,
    clearAll
  };
}

class DOMEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.defaultPrevented = false;
    this.target = null;
    this.currentTarget = null;
    this._stopped = false;
    Object.assign(this, init);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this._stopped = true; }
}

class DOMEventTarget {
  constructor() {
    this._listeners = new Map();
  }
  addEventListener(type, fn, opts) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    if (this._listeners.has(type)) this._listeners.get(type).delete(fn);
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    const fns = this._listeners.get(event.type);
    if (fns) {
      for (const fn of Array.from(fns)) {
        try {
          fn.call(this, event);
        } catch (e) {
          console.error(`Error in event listener for ${event.type}:`, e);
        }
      }
    }
    const onProp = 'on' + event.type;
    if (typeof this[onProp] === 'function') {
      try {
        this[onProp].call(this, event);
      } catch (e) {
        console.error(`Error in on${event.type}:`, e);
      }
    }
    if (event.bubbles && this.parentNode && !event._stopped) {
      this.parentNode.dispatchEvent(event);
    }
    return !event.defaultPrevented;
  }
}

class DOMNode extends DOMEventTarget {
  constructor(nodeType, nodeName) {
    super();
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.parentNode = null;
    this.ownerDocument = null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.removeChild(this);
    }
  }
}

class DOMTextNode extends DOMNode {
  constructor(text = '') {
    super(3, '#text');
    this.nodeValue = String(text);
  }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = String(v); }
}

function parseSelectorPart(sel) {
  // Parses a simple selector like tag#id.c1.c2[attr=val]:not(...)
  const part = {
    tag: null,
    id: null,
    classes: [],
    attrs: [],
    not: null,
    nthChild: null,
    checked: false,
    disabled: false
  };

  let s = sel.trim();
  // check :nth-child(n)
  const nthMatch = s.match(/:nth-child\((\d+)\)/);
  if (nthMatch) {
    part.nthChild = parseInt(nthMatch[1], 10);
    s = s.replace(nthMatch[0], '');
  }
  // check :not(...)
  const notMatch = s.match(/:not\(([^)]+)\)/);
  if (notMatch) {
    part.not = parseSelectorPart(notMatch[1]);
    s = s.replace(notMatch[0], '');
  }
  if (s.includes(':checked')) {
    part.checked = true;
    s = s.replace(':checked', '');
  }
  if (s.includes(':disabled')) {
    part.disabled = true;
    s = s.replace(':disabled', '');
  }

  // check attributes [name] or [name="val"]
  const attrMatches = s.matchAll(/\[([a-zA-Z0-9_-]+)(?:([*^$]?=)(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/g);
  for (const m of attrMatches) {
    part.attrs.push({
      name: m[1].toLowerCase(),
      op: m[2] || '=',
      val: m[3] ?? m[4] ?? m[5] ?? null
    });
  }
  s = s.replace(/\[[^\]]+\]/g, '');

  // tag, id, classes
  const idMatch = s.match(/#([a-zA-Z0-9_-]+)/);
  if (idMatch) {
    part.id = idMatch[1];
    s = s.replace(idMatch[0], '');
  }
  const classMatches = s.matchAll(/\.([a-zA-Z0-9_-]+)/g);
  for (const cm of classMatches) {
    part.classes.push(cm[1]);
  }
  s = s.replace(/\.[a-zA-Z0-9_-]+/g, '');
  if (s.trim()) {
    part.tag = s.trim().toUpperCase();
  }
  return part;
}

function matchPart(el, part) {
  if (el.nodeType !== 1) return false;
  if (part.tag && el.tagName !== part.tag && part.tag !== '*') return false;
  if (part.id && el.id !== part.id) return false;
  for (const cls of part.classes) {
    if (!el.classList.contains(cls)) return false;
  }
  for (const attr of part.attrs) {
    const val = el.getAttribute(attr.name);
    if (val === null) return false;
    if (attr.val !== null) {
      if (attr.op === '=' && val !== attr.val) return false;
      if (attr.op === '^=' && !val.startsWith(attr.val)) return false;
      if (attr.op === '$=' && !val.endsWith(attr.val)) return false;
      if (attr.op === '*=' && !val.includes(attr.val)) return false;
    }
  }
  if (part.checked && !el.checked) return false;
  if (part.disabled && !el.disabled) return false;
  if (part.not && matchPart(el, part.not)) return false;
  if (part.nthChild !== null) {
    if (!el.parentNode) return false;
    const siblings = el.parentNode.children || [];
    const idx = siblings.indexOf(el);
    if (idx + 1 !== part.nthChild) return false;
  }
  return true;
}

function matchCompound(el, parts) {
  // parts is array of { combinator: ' ' | '>', part: parseSelectorPart(...) }
  if (!matchPart(el, parts[parts.length - 1].part)) return false;
  let cur = el;
  for (let i = parts.length - 2; i >= 0; i--) {
    const comb = parts[i + 1].combinator;
    const targetPart = parts[i].part;
    if (comb === '>') {
      cur = cur.parentElement;
      if (!cur || !matchPart(cur, targetPart)) return false;
    } else {
      let found = false;
      cur = cur.parentElement;
      while (cur) {
        if (matchPart(cur, targetPart)) {
          found = true;
          break;
        }
        cur = cur.parentElement;
      }
      if (!found) return false;
    }
  }
  return true;
}

function parseComplexSelector(sel) {
  // sel is comma-free selector, e.g. "section.card > div.content .btn:not(.hidden)"
  const tokens = sel.trim().split(/(\s*>\s*|\s+)/).filter(Boolean);
  const parts = [];
  let nextComb = ' ';
  for (const t of tokens) {
    const tr = t.trim();
    if (tr === '>') {
      nextComb = '>';
    } else if (tr === '') {
      nextComb = ' ';
    } else {
      parts.push({ combinator: nextComb, part: parseSelectorPart(tr) });
      nextComb = ' ';
    }
  }
  return parts;
}

function matchesSelector(el, selector) {
  const groups = selector.split(',').map(s => s.trim());
  for (const grp of groups) {
    const parts = parseComplexSelector(grp);
    if (matchCompound(el, parts)) return true;
  }
  return false;
}

function queryAllInSubtree(root, selector) {
  const results = [];
  const groups = selector.split(',').map(s => s.trim());
  const parsedGroups = groups.map(g => parseComplexSelector(g));

  function walk(node) {
    for (const child of node.children) {
      for (const parts of parsedGroups) {
        if (matchCompound(child, parts)) {
          results.push(child);
          break;
        }
      }
      walk(child);
    }
  }
  walk(root);
  return results;
}

class DOMElement extends DOMNode {
  constructor(tagName, ownerDocument) {
    super(1, tagName.toUpperCase());
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.childNodes = [];
    this._attrs = new Map();
    this._checked = undefined;
    this._value = undefined;
    this._rect = null;

    // Dataset Proxy
    this.dataset = new Proxy({}, {
      get: (target, prop) => {
        const attr = 'data-' + prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        return this.getAttribute(attr) ?? undefined;
      },
      set: (target, prop, val) => {
        const attr = 'data-' + prop.replace(/([A-Z])/g, '-$1').toLowerCase();
        this.setAttribute(attr, String(val));
        return true;
      }
    });

    // Style Proxy
    this._styleProps = new Map();
    this.style = new Proxy({}, {
      get: (target, prop) => {
        if (prop === 'getPropertyValue') return (name) => this._styleProps.get(name) || '';
        if (prop === 'setProperty') return (name, val) => { this._styleProps.set(name, String(val)); };
        if (prop === 'removeProperty') return (name) => { this._styleProps.delete(name); };
        return this._styleProps.get(prop) || '';
      },
      set: (target, prop, val) => {
        this._styleProps.set(prop, String(val));
        return true;
      }
    });

    // ClassList
    this.classList = {
      add: (...tokens) => {
        const list = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        for (const t of tokens) if (!list.includes(t)) list.push(t);
        this.setAttribute('class', list.join(' '));
      },
      remove: (...tokens) => {
        const list = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        const filtered = list.filter(c => !tokens.includes(c));
        this.setAttribute('class', filtered.join(' '));
      },
      toggle: (token, force) => {
        const has = this.classList.contains(token);
        const next = force !== undefined ? !!force : !has;
        if (next) this.classList.add(token);
        else this.classList.remove(token);
        return next;
      },
      contains: (token) => {
        const list = (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
        return list.includes(token);
      }
    };
  }

  getAttribute(name) {
    const val = this._attrs.get(name.toLowerCase());
    return val !== undefined ? val : null;
  }
  setAttribute(name, val) {
    this._attrs.set(name.toLowerCase(), String(val));
  }
  removeAttribute(name) {
    this._attrs.delete(name.toLowerCase());
  }
  hasAttribute(name) {
    return this._attrs.has(name.toLowerCase());
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }

  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }

  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }

  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }

  get type() { return this.getAttribute('type') || ''; }
  set type(v) { this.setAttribute('type', v); }

  get name() { return this.getAttribute('name') || ''; }
  set name(v) { this.setAttribute('name', v); }

  get href() { return this.getAttribute('href') || ''; }
  set href(v) { this.setAttribute('href', v); }

  get target() { return this.getAttribute('target') || ''; }
  set target(v) { this.setAttribute('target', v); }

  get rel() { return this.getAttribute('rel') || ''; }
  set rel(v) { this.setAttribute('rel', v); }

  get src() { return this.getAttribute('src') || ''; }
  set src(v) { this.setAttribute('src', v); }

  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }

  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }

  get checked() {
    return this._checked !== undefined ? this._checked : this.hasAttribute('checked');
  }
  set checked(v) {
    this._checked = !!v;
  }

  get value() {
    return this._value !== undefined ? this._value : (this.getAttribute('value') || '');
  }
  set value(v) {
    this._value = String(v);
  }

  get textContent() {
    let out = '';
    for (const child of this.childNodes) {
      out += child.textContent;
    }
    return out;
  }
  set textContent(v) {
    this.children = [];
    this.childNodes = [];
    if (v !== '') {
      const tn = new DOMTextNode(v);
      tn.parentNode = this;
      tn.ownerDocument = this.ownerDocument;
      this.childNodes.push(tn);
    }
  }

  get innerText() { return this.textContent; }
  set innerText(v) { this.textContent = v; }

  get innerHTML() {
    let out = '';
    for (const node of this.childNodes) {
      if (node.nodeType === 3) {
        out += node.nodeValue;
      } else if (node.nodeType === 1) {
        const tag = node.tagName.toLowerCase();
        let attrs = '';
        for (const [k, v] of node._attrs.entries()) {
          attrs += ` ${k}="${v.replace(/"/g, '&quot;')}"`;
        }
        out += `<${tag}${attrs}>${node.innerHTML}</${tag}>`;
      }
    }
    return out;
  }
  set innerHTML(html) {
    this.children = [];
    this.childNodes = [];
    if (!html) return;
    const doc = this.ownerDocument || new DOMDocument();
    const fragment = parseHtmlIntoFragment(html, doc);
    for (const child of Array.from(fragment.childNodes)) {
      this.appendChild(child);
    }
  }

  appendChild(child) {
    if (child.nodeType === 11) { // DocumentFragment
      for (const c of Array.from(child.childNodes)) {
        this.appendChild(c);
      }
      return child;
    }
    if (child.parentNode) {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    if (child.nodeType === 1) {
      this.children.push(child);
    }
    return child;
  }

  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    if (child.nodeType === 1) {
      const cIdx = this.children.indexOf(child);
      if (cIdx !== -1) this.children.splice(cIdx, 1);
    }
    return child;
  }

  insertBefore(newNode, refNode) {
    if (!refNode) return this.appendChild(newNode);
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    const idx = this.childNodes.indexOf(refNode);
    if (idx === -1) return this.appendChild(newNode);
    newNode.parentNode = this;
    newNode.ownerDocument = this.ownerDocument;
    this.childNodes.splice(idx, 0, newNode);
    if (newNode.nodeType === 1) {
      const cIdx = this.children.indexOf(refNode);
      if (cIdx !== -1) this.children.splice(cIdx, 0, newNode);
      else this.children.push(newNode);
    }
    return newNode;
  }

  replaceChild(newChild, oldChild) {
    this.insertBefore(newChild, oldChild);
    this.removeChild(oldChild);
    return oldChild;
  }

  getBoundingClientRect() {
    return this._rect || { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300, x: 0, y: 0 };
  }
  get offsetWidth() { return this._rect?.width || 300; }
  get offsetHeight() { return this._rect?.height || 300; }
  get clientWidth() { return this._rect?.width || 300; }
  get clientHeight() { return this._rect?.height || 300; }
  get width() { return Number(this.getAttribute('width') || (this._rect?.width || 300)); }
  set width(v) { this.setAttribute('width', String(v)); if (!this._rect) this._rect = { left: 0, top: 0, right: Number(v), bottom: 300, width: Number(v), height: 300, x: 0, y: 0 }; else this._rect.width = Number(v); }
  get height() { return Number(this.getAttribute('height') || (this._rect?.height || 300)); }
  set height(v) { this.setAttribute('height', String(v)); if (!this._rect) this._rect = { left: 0, top: 0, right: 300, bottom: Number(v), width: 300, height: Number(v), x: 0, y: 0 }; else this._rect.height = Number(v); }

  click() {
    if (this.tagName === 'INPUT') {
      const inputType = (this.type || '').toLowerCase();
      if (inputType === 'checkbox') {
        this.checked = !this.checked;
        this.dispatchEvent(new DOMEvent('click', { bubbles: true, cancelable: true }));
        this.dispatchEvent(new DOMEvent('change', { bubbles: true }));
        this.dispatchEvent(new DOMEvent('input', { bubbles: true }));
        return;
      } else if (inputType === 'radio') {
        if (this.name && this.ownerDocument) {
          const others = this.ownerDocument.getElementsByName(this.name);
          for (const el of others) {
            if (el !== this) el.checked = false;
          }
        }
        this.checked = true;
        this.dispatchEvent(new DOMEvent('click', { bubbles: true, cancelable: true }));
        this.dispatchEvent(new DOMEvent('change', { bubbles: true }));
        this.dispatchEvent(new DOMEvent('input', { bubbles: true }));
        return;
      }
    }
    this.dispatchEvent(new DOMEvent('click', { bubbles: true, cancelable: true }));
  }

  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
    this.dispatchEvent(new DOMEvent('focus', { bubbles: false }));
  }
  blur() {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
    this.dispatchEvent(new DOMEvent('blur', { bubbles: false }));
  }
  select() {}
  scrollIntoView() {}
  scrollTo() {}
  scrollBy() {}
  scroll() {}
  append(...nodes) {
    for (const n of nodes) {
      this.appendChild(typeof n === 'string' ? new DOMTextNode(n) : n);
    }
  }
  prepend(...nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      const node = typeof n === 'string' ? new DOMTextNode(n) : n;
      this.insertBefore(node, this.childNodes[0] || null);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.childNodes = [];
    for (const n of nodes) {
      if (typeof n === 'string') {
        this.appendChild(new DOMTextNode(n));
      } else if (n) {
        this.appendChild(n);
      }
    }
  }

  querySelector(selector) {
    const list = queryAllInSubtree(this, selector);
    return list[0] || null;
  }
  querySelectorAll(selector) {
    return queryAllInSubtree(this, selector);
  }
  matches(selector) {
    return matchesSelector(this, selector);
  }

  getContext(type) {
    if (type === '2d') {
      if (!this._ctx2d) {
        this._ctx2d = createCanvasContext2D(this);
      }
      return this._ctx2d;
    }
    return null;
  }
  transferControlToOffscreen() {
    return new OffscreenCanvas(this.width || 300, this.height || 150);
  }
}

class DOMDocumentFragment extends DOMNode {
  constructor(ownerDocument) {
    super(11, '#document-fragment');
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.childNodes = [];
  }
  appendChild(child) {
    if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = this;
    child.ownerDocument = this.ownerDocument;
    this.childNodes.push(child);
    if (child.nodeType === 1) this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      child.parentNode = null;
    }
    if (child.nodeType === 1) {
      const cIdx = this.children.indexOf(child);
      if (cIdx !== -1) this.children.splice(cIdx, 1);
    }
    return child;
  }
}

class DOMDocument extends DOMEventTarget {
  constructor() {
    super();
    this.nodeType = 9;
    this.nodeName = '#document';
    this.ownerDocument = this;
    this.visibilityState = 'visible';
    this.documentElement = new DOMElement('html', this);
    this.head = new DOMElement('head', this);
    this.body = new DOMElement('body', this);
    this.documentElement.appendChild(this.head);
    this.documentElement.appendChild(this.body);
    this.activeElement = null;
  }

  createElement(tagName) {
    return new DOMElement(tagName, this);
  }
  createTextNode(text) {
    const tn = new DOMTextNode(text);
    tn.ownerDocument = this;
    return tn;
  }
  createDocumentFragment() {
    return new DOMDocumentFragment(this);
  }

  getElementById(id) {
    let found = null;
    function walk(node) {
      if (found) return;
      if (node.nodeType === 1 && node.id === id) {
        found = node;
        return;
      }
      for (const child of node.children) {
        walk(child);
      }
    }
    walk(this.documentElement);
    return found;
  }

  getElementsByName(name) {
    const res = [];
    function walk(node) {
      if (node.nodeType === 1 && node.getAttribute('name') === name) {
        res.push(node);
      }
      for (const child of node.children) {
        walk(child);
      }
    }
    walk(this.documentElement);
    return res;
  }

  getElementsByClassName(className) {
    return queryAllInSubtree(this.documentElement, '.' + className);
  }

  getElementsByTagName(tagName) {
    return queryAllInSubtree(this.documentElement, tagName);
  }

  querySelector(selector) {
    if (selector.startsWith('#') && !selector.includes(' ') && !selector.includes('>') && !selector.includes(',')) {
      return this.getElementById(selector.slice(1));
    }
    const list = queryAllInSubtree(this.documentElement, selector);
    return list[0] || null;
  }

  querySelectorAll(selector) {
    return queryAllInSubtree(this.documentElement, selector);
  }
}

function createCanvasContext2D(canvas) {
  const gradient = { addColorStop() {} };
  return {
    canvas,
    fillStyle: '#000000',
    strokeStyle: '#000000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    fillRect() {},
    clearRect() {},
    strokeRect() {},
    beginPath() {},
    arc() {},
    ellipse() {},
    rect() {},
    clip() {},
    globalCompositeOperation: 'source-over',
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    save() {},
    restore() {},
    scale() {},
    rotate() {},
    translate() {},
    drawImage() {},
    createRadialGradient() { return gradient; },
    createLinearGradient() { return gradient; },
    createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
    putImageData() {},
    setTransform() {},
    fillText() {},
    measureText(text) { return { width: String(text).length * 7 }; }
  };
}

class OffscreenCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this._ctx = createCanvasContext2D(this);
  }
  getContext(type) {
    if (type === '2d') return this._ctx;
    return null;
  }
}

class MockRTCPeerConnection {
  constructor(config = {}) {
    this.config = config;
    this.iceGatheringState = 'new';
    this.onicecandidate = null;
    this.onicegatheringstatechange = null;
  }
  createDataChannel(label) { return { label }; }
  async createOffer() { return { type: 'offer', sdp: '' }; }
  async setLocalDescription(desc) { return; }
  close() {}
}

const VOID_TAGS = new Set(['AREA', 'BASE', 'BR', 'COL', 'EMBED', 'HR', 'IMG', 'INPUT', 'LINK', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);

function parseHtmlIntoFragment(html, document) {
  const fragment = document.createDocumentFragment();
  const stack = [fragment];
  let pos = 0;
  const n = html.length;

  while (pos < n) {
    const nextLt = html.indexOf('<', pos);
    if (nextLt === -1) {
      const text = html.slice(pos);
      if (text) fragment.appendChild(document.createTextNode(text));
      break;
    }
    if (nextLt > pos) {
      const text = html.slice(pos, nextLt);
      if (text) stack[stack.length - 1].appendChild(document.createTextNode(text));
    }
    if (html.startsWith('<!--', nextLt)) {
      const endC = html.indexOf('-->', nextLt + 4);
      pos = endC === -1 ? n : endC + 3;
      continue;
    }
    if (html.startsWith('<!', nextLt)) {
      const endD = html.indexOf('>', nextLt + 2);
      pos = endD === -1 ? n : endD + 1;
      continue;
    }
    if (html.startsWith('</', nextLt)) {
      const endTag = html.indexOf('>', nextLt + 2);
      if (endTag === -1) break;
      const tag = html.slice(nextLt + 2, endTag).trim().split(/\s+/)[0].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) {
          stack.length = i;
          break;
        }
      }
      pos = endTag + 1;
      continue;
    }

    // Opening or self-closing tag
    const endTag = html.indexOf('>', nextLt + 1);
    if (endTag === -1) break;
    let tagStr = html.slice(nextLt + 1, endTag).trim();
    const isSelfClosing = tagStr.endsWith('/');
    if (isSelfClosing) tagStr = tagStr.slice(0, -1).trim();

    const tagParts = tagStr.match(/^[a-zA-Z0-9_-]+/);
    if (!tagParts) {
      pos = endTag + 1;
      continue;
    }
    const tagName = tagParts[0].toUpperCase();
    const el = document.createElement(tagName);

    const attrStr = tagStr.slice(tagName.length);
    const attrRegex = /([a-zA-Z0-9_-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
    let m;
    while ((m = attrRegex.exec(attrStr)) !== null) {
      const aName = m[1];
      const aVal = m[2] ?? m[3] ?? m[4] ?? '';
      el.setAttribute(aName, aVal);
    }

    stack[stack.length - 1].appendChild(el);
    pos = endTag + 1;

    if (!isSelfClosing && !VOID_TAGS.has(tagName)) {
      if (tagName === 'SCRIPT' || tagName === 'STYLE') {
        const closeTag = `</${tagName.toLowerCase()}>`;
        const closeTagIdx = html.toLowerCase().indexOf(closeTag, pos);
        if (closeTagIdx !== -1) {
          const bodyText = html.slice(pos, closeTagIdx);
          el.appendChild(document.createTextNode(bodyText));
          pos = closeTagIdx + closeTag.length;
        }
      } else {
        stack.push(el);
      }
    }
  }
  return fragment;
}

function parseHtmlIntoDocument(html, document) {
  const fragment = parseHtmlIntoFragment(html, document);
  // Separate into head and body
  function findOrCreate(tag, parent) {
    for (const c of parent.children) if (c.tagName === tag) return c;
    const el = document.createElement(tag);
    parent.appendChild(el);
    return el;
  }

  for (const node of Array.from(fragment.childNodes)) {
    if (node.nodeType === 1 && node.tagName === 'HTML') {
      for (const [k, v] of node._attrs.entries()) {
        document.documentElement.setAttribute(k, v);
      }
      for (const c of Array.from(node.children)) {
        if (c.tagName === 'HEAD') {
          for (const sub of Array.from(c.childNodes)) document.head.appendChild(sub);
        } else if (c.tagName === 'BODY') {
          for (const sub of Array.from(c.childNodes)) document.body.appendChild(sub);
        } else {
          document.body.appendChild(c);
        }
      }
    } else if (node.nodeType === 1 && (node.tagName === 'HEAD' || node.tagName === 'META' || node.tagName === 'TITLE' || node.tagName === 'LINK')) {
      document.head.appendChild(node);
    } else {
      document.body.appendChild(node);
    }
  }
}

function createDomEnvironment(opts = {}) {
  const clock = opts.clock || createClock();
  const document = new DOMDocument();
  if (opts.htmlRelPath) {
    const absPath = path.resolve(ROOT, opts.htmlRelPath);
    if (fs.existsSync(absPath)) {
      const html = fs.readFileSync(absPath, 'utf8');
      parseHtmlIntoDocument(html, document);
    }
  }

  const helpers = {
    resizeObservers: [],
    mediaQueries: new Map(),
    getMediaQuery(q) {
      if (!helpers.mediaQueries.has(q)) {
        let matches = false;
        if (q.includes('prefers-reduced-motion: reduce')) matches = !!opts.prefersReducedMotion;
        if (q.includes('prefers-color-scheme: dark')) matches = !!opts.prefersDark;
        const listeners = new Set();
        const mq = {
          get matches() { return matches; },
          media: q,
          onchange: null,
          addListener(fn) { listeners.add(fn); },
          removeListener(fn) { listeners.delete(fn); },
          addEventListener(t, fn) { if (t === 'change') listeners.add(fn); },
          removeEventListener(t, fn) { if (t === 'change') listeners.delete(fn); },
          setMatches(val) {
            matches = !!val;
            const ev = new DOMEvent('change', { matches });
            for (const fn of Array.from(listeners)) try { fn(ev); } catch (e) { console.error(e); }
            if (typeof mq.onchange === 'function') try { mq.onchange(ev); } catch (e) { console.error(e); }
          }
        };
        helpers.mediaQueries.set(q, mq);
      }
      return helpers.mediaQueries.get(q);
    },
    clipboardWrites: [],
    clipboardFail: false,
    setClipboardFail(val) { helpers.clipboardFail = !!val; }
  };

  class MockResizeObserver {
    constructor(cb) {
      this.cb = cb;
      this.observed = [];
      helpers.resizeObservers.push(this);
    }
    observe(target) { this.observed.push(target); }
    unobserve(target) { this.observed = this.observed.filter(t => t !== target); }
    disconnect() { this.observed = []; }
    trigger(entries = []) {
      if (!entries.length && this.observed.length) {
        entries = this.observed.map(target => ({
          target,
          contentRect: target.getBoundingClientRect()
        }));
      }
      this.cb(entries, this);
    }
  }

  const localStorageMap = new Map(Object.entries(opts.initialLocalStorage || {}));
  const localStorage = {
    getItem(k) { return localStorageMap.has(String(k)) ? localStorageMap.get(String(k)) : null; },
    setItem(k, v) { localStorageMap.set(String(k), String(v)); },
    removeItem(k) { localStorageMap.delete(String(k)); },
    clear() { localStorageMap.clear(); },
    get length() { return localStorageMap.size; },
    key(n) { return Array.from(localStorageMap.keys())[n] || null; }
  };

  const window = new DOMEventTarget();
  window.document = document;
  window.window = window;
  window.self = window;
  window.top = window;
  window.globalThis = window;
  window.Date = clock.Date;
  window.setTimeout = clock.setTimeout;
  window.clearTimeout = clock.clearTimeout;
  window.setInterval = clock.setInterval;
  window.clearInterval = clock.clearInterval;
  window.requestAnimationFrame = clock.requestAnimationFrame;
  window.cancelAnimationFrame = clock.cancelAnimationFrame;
  window.ResizeObserver = MockResizeObserver;
  window.matchMedia = (q) => helpers.getMediaQuery(q);
  window.localStorage = localStorage;
  window.sessionStorage = { ...localStorage };
  window.innerWidth = opts.innerWidth || 800;
  window.innerHeight = opts.innerHeight || 600;
  window.devicePixelRatio = opts.devicePixelRatio || 1;
  window.scrollX = 0;
  window.scrollY = 0;
  window.scrollTo = (x, y) => { window.scrollX = typeof x === 'object' ? (x.left || 0) : x; window.scrollY = typeof x === 'object' ? (x.top || 0) : y; };
  window.scrollBy = (x, y) => { window.scrollX += x; window.scrollY += y; };
  window.getComputedStyle = (el) => ({ ...el.style, animationName: 'none' });
  window.chrome = opts.chrome || null;
  window.RTCPeerConnection = MockRTCPeerConnection;
  window.webkitRTCPeerConnection = MockRTCPeerConnection;
  window.HTMLCanvasElement = DOMElement;
  window.OffscreenCanvas = OffscreenCanvas;
  window.CustomEvent = DOMEvent;
  window.Event = DOMEvent;
  window.MouseEvent = DOMEvent;
  window.KeyboardEvent = DOMEvent;
  window.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3, DOCUMENT_FRAGMENT_NODE: 11 };
  window.Element = DOMElement;
  window.HTMLElement = DOMElement;
  window.performance = { now: () => clock.now() };
  window.Blob = globalThis.Blob;
  const mockUrl = globalThis.URL;
  if (!mockUrl.createObjectURL) {
    mockUrl.createObjectURL = () => 'blob:leakhalo/' + Math.random().toString(36).slice(2);
    mockUrl.revokeObjectURL = () => {};
  }
  window.URL = mockUrl;
  window.history = {
    replaceState(state, title, url) {
      if (typeof url === 'string') {
        const hashIdx = url.indexOf('#');
        if (hashIdx !== -1) window.location.hash = url.slice(hashIdx);
      }
    },
    pushState(state, title, url) {
      if (typeof url === 'string') {
        const hashIdx = url.indexOf('#');
        if (hashIdx !== -1) window.location.hash = url.slice(hashIdx);
      }
    }
  };
  window.location = { href: '', search: '', hash: '', pathname: '', protocol: 'chrome-extension:' };
  window.navigator = {
    onLine: true,
    language: 'en-US',
    languages: ['en-US', 'en'],
    userAgent: 'Mozilla/5.0 LeakHaloTest',
    clipboard: {
      async writeText(text) {
        if (helpers.clipboardFail) throw new Error('Clipboard failed');
        helpers.clipboardWrites.push(String(text));
      }
    }
  };
  window.alert = () => {};
  window.prompt = () => null;
  window.confirm = () => true;

  if (opts.clientWidth !== undefined) {
    document.documentElement._rect = { left: 0, top: 0, right: opts.clientWidth, bottom: 800, width: opts.clientWidth, height: 800 };
  }

  return { window, document, clock, helpers };
}

function runExtensionScript(relPath, context) {
  const abs = path.resolve(ROOT, relPath);
  const code = fs.readFileSync(abs, 'utf8');
  vm.runInContext(code, context, { filename: abs });
}

module.exports = {
  createClock,
  DOMEvent,
  DOMEventTarget,
  DOMElement,
  DOMDocument,
  OffscreenCanvas,
  parseHtmlIntoDocument,
  createDomEnvironment,
  runExtensionScript
};
