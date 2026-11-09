// Pure logic for the mod manager, with no herdr imports so node can test it:
// classifying mods, finding where layouts use them, taking blocks out and
// putting them back, and reading and changing key bindings.
export const SELF = "mod-manager";
// Herdr's own interface: dialogs, menus and notifications other mods open.
export const CORE = new Set(["confirm", "help", "machine-add", "menu", "new-menu", "prompt", "toast"]);
// Keys terminal programs rely on (AGENTS.md, Keys).
export const RESERVED = new Set(["ctrl-a", "ctrl-c", "ctrl-d", "ctrl-e", "ctrl-k", "ctrl-l", "ctrl-r", "ctrl-u", "ctrl-w", "ctrl-z", "ctrl-["]);

export function classify(name, natives, modJson) {
  if (natives.has(name)) return "native";
  return modJson?.cloned_from ? "clone" : "installed";
}

const children = (n) => (Array.isArray(n?.children) ? n.children : []);

// Every use of a mod in a layout: `block` is a removable block, otherwise it
// sits inside another setting (a pane header, terminal_menu) and has no block.
export function layoutRefs(tree) {
  const out = [];
  const deep = (v) => {
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "mod" && typeof x === "string") out.push({ mod: x, block: null });
      else deep(x);
    }
  };
  const walk = (n) => {
    if (n?.terminal_menu) out.push({ mod: n.terminal_menu, block: null });
    const { children: _c, ...rest } = n ?? {};
    if (n?.type === "block" && typeof n.content?.mod === "string") {
      out.push({ mod: n.content.mod, block: n.id ?? null });
      const { mod: _m, ...content } = n.content;
      deep(content);
    } else deep(rest);
    children(n).forEach(walk);
  };
  walk(tree);
  return out;
}

const copy = (v) => JSON.parse(JSON.stringify(v));

// Takes the mod's blocks out. Returns the new tree and what's needed to put them back.
export function removeBlocks(input, name) {
  const tree = copy(input), removed = [];
  const walk = (n) => {
    const kids = children(n);
    for (let i = kids.length - 1; i >= 0; i--) {
      const c = kids[i];
      if (c.type === "block" && c.content?.mod === name) {
        const wasActive = n.active === c.id;
        kids.splice(i, 1);
        if (wasActive) n.active = kids[0]?.id;
        removed.unshift({ parent: n.id ?? null, index: i, node: c, active: wasActive });
      } else walk(c);
    }
  };
  walk(tree);
  return { tree, removed };
}

function findNode(n, id) {
  if (n?.id === id) return n;
  for (const c of children(n)) { const f = findNode(c, id); if (f) return f; }
  return null;
}

// Puts blocks back where they were. `missing` lists those whose parent is gone.
export function restoreBlocks(input, removed) {
  const tree = copy(input), missing = [];
  for (const r of removed) {
    const parent = r.parent === null ? null : findNode(tree, r.parent);
    if (!parent || !Array.isArray(parent.children)) { missing.push(r.node.id); continue; }
    parent.children.splice(Math.min(r.index, parent.children.length), 0, copy(r.node));
    if (r.active) parent.active = r.node.id;
  }
  return { tree, missing };
}

// "ctrl-shift-g" and "shift-ctrl-g" are the same key; "ctrl--" ends in a minus.
export function normalizeKey(k) {
  const text = String(k).trim().toLowerCase();
  const minus = text.endsWith("-") && text.length > 1;
  const parts = (minus ? text.slice(0, -1) : text).split("-").filter(Boolean);
  const key = minus ? "-" : parts.pop();
  return [...parts.sort(), key].join("-");
}

export const validKey = (k) => /^(?:(?:ctrl|alt|shift|cmd|super)-)+.+$|^f([1-9]|1[0-2])$/.test(String(k).trim().toLowerCase());

const actionName = (a) => (typeof a === "string" ? a : a?.command ?? "");

// The mod a binding opens, or null for one of Herdr's own commands.
// `blockMod(id)` is the mod in a panel block; `known` holds mod names.
export function actionOwner(action, { blockMod = () => null, known = new Set() } = {}) {
  const text = actionName(action);
  if (text.startsWith("mod.open:")) return text.slice(9);
  if (text === "layout.toggle" && typeof action?.args?.id === "string") return blockMod(action.args.id);
  const dot = text.indexOf(".");
  return dot > 0 && known.has(text.slice(0, dot)) ? text.slice(0, dot) : null;
}

export function bindings(keys) {
  const out = [];
  for (const [section, map] of Object.entries(keys ?? {})) for (const [key, action] of Object.entries(map ?? {})) out.push({ section, key, action });
  return out;
}

export const keysOf = (keys, mod, ctx) => bindings(keys).filter((b) => actionOwner(b.action, ctx) === mod);

// What already uses `key`, other than this mod.
export function conflicts(keys, key, mod, ctx) {
  const want = normalizeKey(key);
  return bindings(keys).filter((b) => normalizeKey(b.key) === want)
    .map((b) => ({ ...b, owner: actionOwner(b.action, ctx) }))
    .filter((b) => b.owner !== mod);
}

export function without(keys, list) {
  const next = copy(keys ?? {});
  for (const b of list) if (next[b.section]) delete next[b.section][b.key];
  return next;
}

// Gives the mod `key` alone: its old keys and whatever held this one go.
export function setShortcut(keys, mod, key, action, ctx) {
  const next = without(keys, [...keysOf(keys, mod, ctx), ...conflicts(keys, key, mod, ctx)]);
  next.global = { ...(next.global ?? {}), [normalizeKey(key)]: action };
  return next;
}

// How a key opens this mod: its overlay, or showing and hiding its block.
// A block inside a stack is left out: layout.toggle hides it rather than selecting it.
export function opener(name, modJson, tree) {
  if (modJson?.overlay) return `mod.open:${name}`;
  let found = null;
  const walk = (n) => {
    for (const c of children(n)) {
      if (!found && n.type !== "stack" && c.type === "block" && c.content?.mod === name && c.id) found = c.id;
      walk(c);
    }
  };
  walk(tree);
  return found ? { command: "layout.toggle", args: { id: found } } : null;
}

// Mods another mod's code names, from `grep -o` lines "mods/<from>/x.js:<match>".
export function codeRefs(text) {
  const used = new Map();
  for (const line of String(text).split("\n")) {
    const m = /^mods\/([a-z0-9-]+)\/[^:]*:(.*)$/.exec(line);
    const target = m && (/^mods\/([a-z0-9-]+)/.exec(m[2]) ?? /"([a-z0-9-]+)"/.exec(m[2]))?.[1];
    if (!target || target === m[1] || m[1] === SELF) continue;
    if (!used.has(target)) used.set(target, new Set());
    used.get(target).add(m[1]);
  }
  return used;
}

// Icons to choose from, shipped in icons/ (Material Icon Theme, MIT).
export const PRESETS = ["folder", "folder-src", "folder-base", "folder-tools", "folder-plugin", "folder-ui", "folder-tasks", "folder-git", "folder-robot", "folder-layout", "folder-theme", "folder-update", "folder-app", "folder-views", "folder-windows", "file", "document", "markdown", "pdf", "table", "image", "video", "audio", "zip", "git", "console", "command", "settings", "tune", "lock", "key", "certificate", "search", "todo", "toc", "log", "rocket", "robot", "agent", "lighthouse", "palette", "http", "tree", "database", "docker", "kubernetes", "terraform", "nodejs", "npm", "pnpm", "yarn", "bun", "javascript", "typescript", "python", "rust", "go", "react", "vue", "svelte", "graphql", "claude", "copilot", "cursor", "gemini-ai", "figma"];

const DEFAULTS = {
  agents: "agent", changes: "git", files: "folder", help: "document",
  spaces: "folder-layout", tabs: "folder-windows", picker: "search", peek: "image", pane: "folder-views",
  "mod-manager": "folder-plugin", "markdown-notes": "markdown", worktree: "folder-git", win98: "folder-windows", menu: "toc", "new-menu": "toc",
  confirm: "todo", prompt: "console", toast: "log", "machine-add": "http", "terminals-bar": "console", "terminals-pane": "console",
  "workspace-chrome": "folder-ui", "workspace-status": "folder-ui",
};
export const defaultIcon = (name) => DEFAULTS[name] ?? "folder-plugin";
