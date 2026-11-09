// A manager for Herdr's mods: native ones can be turned off, your own turned off
// or sent to a trash; any mod can get a name, an icon and a shortcut.
// Herdr has no "off" for a mod, so turning one off takes its blocks out of your
// layouts and its keys out of keys.json (and moves your own mods' folders aside),
// remembering all of it to put back. Names and icons live in shared state
// ("mod-manager.labels": { <mod>: { name?, icon? } }), so other mods can show them too.
import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, readTextFile, writeTextFile, shared, setShared, theme, notify } from "herdr";
import * as M from "./model.js";

const STATE = "mod-manager", LABELS = "mod-manager.labels";
// Top to bottom. Native mods come last: they're the ones you touch least.
const GROUPS = [["installed", "Installed"], ["clone", "Clones"], ["trash", "Trash"], ["native", "Built in"]];
const KIND = { native: "Comes with Herdr", installed: "Installed by you" };
const ICON_COLUMNS = 9;
const state = () => ({ disabled: {}, trash: [], ...(shared(STATE) ?? {}) });
const parse = (text, fallback) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

export default class ModManager extends View {
  init(_props, cx) {
    this.rows = []; this.layouts = []; this.selected = null; this.ask = null; this.busy = null; this.msg = null; this.picking = false;
    this.folded = parse(localStorage.getItem("folded"), { native: true });
    this.name = InputState.new({ placeholder: "Name" });
    this.key = InputState.new({ placeholder: "No shortcut, e.g. ctrl-shift-g" });
    this.search = InputState.new({ placeholder: "Search mods" });
    this.iconSearch = InputState.new({ placeholder: "Search icons" });
    for (const input of [this.key, this.search, this.iconSearch]) input.on("change", (_e, cx) => cx.notify());
    this.name.on("blur", (_e, cx) => this.saveName(cx));
    this.name.on("submit", (_e, cx) => this.saveName(cx));
    this.key.on("submit", (_e, cx) => this.saveKey(cx));
    this.load(cx);
  }

  path(...parts) { return [appHome().replace(/\/$/, ""), ...parts].join("/"); }

  // --- reading -----------------------------------------------------------------

  load(cx, then) {
    cx.spawn(async (cx) => {
      try { await this.read(); then?.(); }
      catch (e) { this.msg = `Couldn't read your setup: ${e?.message ?? e}`; }
      cx.notify();
    });
  }

  async read() {
    const ls = async (dir) => { const r = await exec("ls", ["-1", dir]); return r.code === 0 ? r.stdout.split("\n").filter(Boolean) : []; };
    const installed = parse(await readTextFile(this.path("installed.json")), {});
    const natives = new Set(Object.keys(installed).filter((k) => !k.includes(":")));
    const shipped = new Set(Object.keys(installed).filter((k) => k.startsWith("layout:")).map((k) => k.slice(7)));
    this.layouts = [];
    for (const file of (await ls(this.path("layouts"))).filter((f) => f.endsWith(".json"))) {
      const raw = await readTextFile(this.path("layouts", file)), name = file.slice(0, -5), tree = parse(raw, null);
      if (tree) this.layouts.push({ name, file, raw, tree, shipped: shipped.has(name), refs: M.layoutRefs(tree) });
    }
    this.keysRaw = await readTextFile(this.path("keys.json"));
    this.keys = parse(this.keysRaw, {});
    const grep = await exec("grep", ["-rEoH", "--include=*.js", 'mods/[a-z0-9-]+|mod: *"[a-z0-9-]+"|MOD = "[a-z0-9-]+"', "mods"], { cwd: this.path() });
    const code = M.codeRefs(grep.stdout), st = state(), rows = [];
    for (const name of await ls(this.path("mods"))) {
      const json = parse(await readTextFile(this.path("mods", name, "mod.json")), null);
      rows.push({ name, json, group: M.classify(name, natives, json), off: Boolean(st.disabled[name]) });
    }
    for (const [name, d] of Object.entries(st.disabled)) if (!rows.some((r) => r.name === name)) rows.push({ name, json: d.json ?? null, group: d.group, off: true });
    this.known = new Set(rows.map((r) => r.name));
    this.rows = rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => ({
      ...r,
      layouts: this.layouts.filter((l) => l.refs.some((x) => x.mod === r.name)).map((l) => l.name),
      mods: [...(code.get(r.name) ?? [])].sort(),
    }));
    const first = GROUPS.map(([g]) => this.rows.find((r) => r.group === g)).find(Boolean);
    if (this.selected?.startsWith("trash:") && state().trash.some((t) => `trash:${t.id}` === this.selected)) return;
    this.pick(this.row(this.selected) ? this.selected : first?.name ?? null);
  }

  row(name) { return this.rows.find((r) => r.name === name); }
  shown() { return this.layouts.find((l) => l.name === shared("layout")) ?? this.layouts.find((l) => !l.shipped); }
  ctx() {
    const tree = this.shown()?.tree;
    const blockMod = (id) => { let found = null; const walk = (n) => { if (n?.id === id) found = n.content?.mod ?? null; (n?.children ?? []).forEach(walk); }; walk(tree); return found; };
    return { blockMod, known: this.known };
  }
  label(name) { return (shared(LABELS) ?? {})[name] ?? {}; }
  title(name) { return this.label(name).name || this.row(name)?.json?.title || name; }

  icon(name) { return this.label(name).icon ?? `mods/${M.SELF}/icons/${M.defaultIcon(name)}.svg`; }
  shortcut(name) { return M.keysOf(this.keys, name, this.ctx())[0]?.key ?? ""; }

  pick(name) {
    this.selected = name; this.ask = null; this.picking = false;
    if (!this.row(name)) return;
    this.name.set_value(this.title(name));
    this.key.set_value(this.shortcut(name));
  }

  // --- writing -----------------------------------------------------------------

  async errors() {
    const r = await exec("herdr-app", ["status"]);
    return parse(r.stdout, {}).errors?.length ?? 0;
  }

  // Writes files, then undoes them if Herdr reports a new error.
  async commit(changes) {
    const before = await this.errors(), done = [];
    for (const c of changes) { await writeTextFile(c.path, c.next, c.raw); done.push(c); }
    await exec("sleep", ["1.2"]);
    if ((await this.errors()) > before) {
      for (const c of done.reverse()) await writeTextFile(c.path, c.raw, c.next);
      throw new Error("Herdr reported an error, so the change was undone");
    }
  }

  keysChange(next) { return { path: this.path("keys.json"), raw: this.keysRaw, next: JSON.stringify(next, null, 2) + "\n" }; }

  // What turning a mod off changes, or `blocked` when a use can't be taken out.
  detach(name) {
    const changes = [], removed = {}, blocked = [];
    for (const l of this.layouts.filter((x) => !x.shipped)) {
      if (l.refs.some((r) => r.mod === name && !r.block)) blocked.push(l.name);
      const r = M.removeBlocks(l.tree, name);
      if (!r.removed.length) continue;
      removed[l.name] = r.removed;
      changes.push({ path: this.path("layouts", l.file), raw: l.raw, next: JSON.stringify(r.tree, null, 2) + "\n" });
    }
    const keys = M.keysOf(this.keys, name, this.ctx());
    if (keys.length) changes.push(this.keysChange(M.without(this.keys, keys)));
    return { changes, removed, keys, blocked };
  }

  // Puts blocks and keys back. Returns what couldn't return.
  attach(record) {
    const changes = [], lost = [];
    for (const [layout, removed] of Object.entries(record.removed ?? {})) {
      const l = this.layouts.find((x) => x.name === layout);
      if (!l) { lost.push(`layout ${layout}`); continue; }
      const r = M.restoreBlocks(l.tree, removed);
      lost.push(...r.missing);
      changes.push({ path: this.path("layouts", l.file), raw: l.raw, next: JSON.stringify(r.tree, null, 2) + "\n" });
    }
    const next = JSON.parse(JSON.stringify(this.keys ?? {}));
    let touched = false;
    for (const b of record.keys ?? []) {
      if (M.bindings(next).some((x) => M.normalizeKey(x.key) === M.normalizeKey(b.key))) { lost.push(`shortcut ${b.key}`); continue; }
      (next[b.section] ??= {})[b.key] = b.action; touched = true;
    }
    if (touched) changes.push(this.keysChange(next));
    return { changes, lost };
  }

  // One job at a time; the list is read again afterwards.
  job(cx, label, work) {
    if (this.busy) return;
    this.busy = label; this.ask = null; this.msg = null;
    cx.spawn(async (cx) => {
      try { await this.read(); this.msg = (await work()) ?? `${label}: done`; await this.read(); }
      catch (e) { this.msg = `${label}: ${e?.message ?? e}`; notify({ title: label, body: String(e?.message ?? e), level: "error", timeout: 5000 }); }
      finally { this.busy = null; cx.notify(); }
    });
    cx.notify();
  }

  async move(from, to) {
    const made = await exec("mkdir", ["-p", to.replace(/\/[^/]+$/, "")]);
    if (made.code !== 0) throw new Error(made.stderr);
    const r = await exec("mv", ["-n", "--", from, to]);
    if (r.code !== 0) throw new Error(r.stderr || "Couldn't move the folder");
  }

  async turnOff(name) {
    const row = this.row(name), d = this.detach(name), st = state();
    if (d.blocked.length) throw new Error(`it isn't a block in ${d.blocked.join(", ")}, so it can't be taken out`);
    await this.commit(d.changes);
    const moved = row.group !== "native";
    if (moved) await this.move(this.path("mods", name), this.path("mod-manager", "disabled", name));
    setShared(STATE, { ...st, disabled: { ...st.disabled, [name]: { group: row.group, json: row.json, removed: d.removed, keys: d.keys, moved } } });
    return `Turned off ${this.title(name)}`;
  }

  async turnOn(name) {
    const st = state(), record = st.disabled[name];
    if (record.moved) {
      await this.move(this.path("mod-manager", "disabled", name), this.path("mods", name));
      const check = await exec("herdr-app", ["check", this.path("mods", name)]);
      if (check.code !== 0) { await this.move(this.path("mods", name), this.path("mod-manager", "disabled", name)); throw new Error(check.stderr || check.stdout); }
    }
    const a = this.attach(record);
    await this.commit(a.changes);
    const { [name]: _gone, ...disabled } = st.disabled;
    setShared(STATE, { ...st, disabled });
    return a.lost.length ? `Turned on ${this.title(name)}; couldn't bring back ${a.lost.join(", ")}` : `Turned on ${this.title(name)}`;
  }

  async trash(name) {
    let st = state(), record = st.disabled[name];
    if (!record) { await this.turnOff(name); await this.read(); st = state(); record = st.disabled[name]; }
    const id = `${name}-${Date.now()}`;
    await this.move(this.path("mod-manager", "disabled", name), this.path("mod-manager", "trash", id));
    const { [name]: _gone, ...disabled } = st.disabled;
    setShared(STATE, { ...st, disabled, trash: [...st.trash, { id, name, ...record }] });
    this.selected = null;
    return `Moved ${name} to Trash`;
  }

  async restore(item) {
    if (this.row(item.name)) throw new Error(`a mod called ${item.name} already exists`);
    const st = state();
    await this.move(this.path("mod-manager", "trash", item.id), this.path("mod-manager", "disabled", item.name));
    const { id: _i, name: _n, ...record } = item;
    setShared(STATE, { ...st, trash: st.trash.filter((t) => t.id !== item.id), disabled: { ...st.disabled, [item.name]: record } });
    await this.read();
    return this.turnOn(item.name);
  }

  async purge(item) {
    if (!/^[a-z0-9-]+$/.test(item.id)) throw new Error("Not a valid Trash id");
    const r = await exec("rm", ["-rf", "--", this.path("mod-manager", "trash", item.id)]);
    if (r.code !== 0) throw new Error(r.stderr);
    const st = state();
    setShared(STATE, { ...st, trash: st.trash.filter((t) => t.id !== item.id) });
    return `Deleted ${item.name} for good`;
  }

  // --- name, icon, shortcut ----------------------------------------------------

  setLabel(name, change) {
    const labels = { ...(shared(LABELS) ?? {}) }, next = { ...(labels[name] ?? {}), ...change };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    if (Object.keys(next).length) labels[name] = next; else delete labels[name];
    setShared(LABELS, labels);
  }

  // The name saves itself; an empty one, or the original, goes back to the original.
  saveName(cx) {
    const name = this.selected, row = this.row(name);
    if (!row) return;
    const text = this.name.value().trim(), original = row.json?.title || name;
    this.setLabel(name, { name: text && text !== original ? text : null });
    if (!text) this.name.set_value(original);
    cx.notify();
  }

  chooseIcon(id, cx) {
    this.setLabel(this.selected, { icon: id ? `mods/${M.SELF}/icons/${id}.svg` : null });
    this.picking = false; this.iconSearch.set_value("");
    cx.notify();
  }

  saveKey(cx) {
    const name = this.selected, row = this.row(name), key = this.key.value().trim(), ctx = this.ctx();
    if (!row || key === this.shortcut(name)) return;
    if (!key) {
      const mine = M.keysOf(this.keys, name, ctx);
      return this.job(cx, "Remove shortcut", async () => { await this.commit([this.keysChange(M.without(this.keys, mine))]); return "Shortcut removed"; });
    }
    if (!M.validKey(key)) { this.msg = "Not a valid shortcut: try ctrl-shift-g or f5"; return cx.notify(); }
    const action = M.opener(name, row.json, this.shown()?.tree);
    if (!action) { this.msg = "This mod can't be opened with a shortcut"; return cx.notify(); }
    const write = () => this.job(cx, "Shortcut", async () => { await this.commit([this.keysChange(M.setShortcut(this.keys, name, key, action, ctx))]); return `Shortcut saved: ${M.normalizeKey(key)}`; });
    const lines = M.conflicts(this.keys, key, name, ctx).map((c) => (c.owner
      ? `${this.title(c.owner)} loses its shortcut (${c.key}).`
      : `Herdr loses ${c.key}: ${typeof c.action === "string" ? c.action : c.action.command} (${c.section}).`));
    if (M.RESERVED.has(M.normalizeKey(key))) lines.push(`Terminal programs stop getting ${key}.`);
    if (!lines.length) return write();
    this.ask = { title: `${key} is already in use`, lines, yes: "Use it anyway", run: write };
    cx.notify();
  }

  warnings(row) {
    const lines = [];
    const personal = row.layouts.filter((n) => !this.layouts.find((l) => l.name === n)?.shipped);
    const shipped = row.layouts.filter((n) => this.layouts.find((l) => l.name === n)?.shipped);
    if (personal.length) lines.push(`It comes out of: ${personal.join(", ")}.`);
    if (shipped.length) lines.push(`It stays in ${shipped.join(", ")}: those are Herdr's and can't be edited.`);
    if (row.mods.length) lines.push(`These mods use it and may break: ${row.mods.join(", ")}.`);
    const keys = M.keysOf(this.keys, row.name, this.ctx());
    if (keys.length) lines.push(`It loses ${keys.map((k) => k.key).join(", ")}.`);
    return lines;
  }

  // --- drawing -----------------------------------------------------------------

  button(id, label, onClick, t, { danger, primary, disabled } = {}) {
    const off = disabled || Boolean(this.busy);
    return h_flex().id(id).h(30).px(12).flex_none().items_center().rounded(7).border_1().text_size(12.5)
      .border_color(primary && !off ? t.solid : t.border).bg(primary && !off ? t.solid : t.raised)
      .text_color(off ? t.dim : primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .when(!off, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85)))
      .on_click((_e, cx) => { if (!off) onClick(cx); }).child(label);
  }

  input(state, t) {
    return Input.new(state).h(32).flex_1().min_w(0).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(13).text_color(t.foreground);
  }

  // One line of the detail: what it is on the left, its control on the right.
  setting(label, control, t, hint) {
    return h_flex().flex_none().py(10).gap(14).items_start().border_t(1).border_color(t.border)
      .child(div().w(92).flex_none().pt(7).text_size(12.5).text_color(t.muted).child(label))
      .child(v_flex().flex_1().min_w(0).gap(5).child(control)
        .when(Boolean(hint), (e) => e.child(div().text_size(11.5).text_color(t.dim).child(hint))));
  }

  listRow(r, t) {
    const on = this.selected === r.name, key = this.shortcut(r.name);
    return h_flex().id(`mm-${r.name}`).h(34).flex_none().pl(10).pr(8).gap(9).items_center().rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.pick(r.name); this.msg = null; cx.notify(); })
      .child(image(this.icon(r.name)).size(18).flex_none().when(r.off, (e) => e.opacity(0.45)))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(r.off ? t.dim : t.foreground).child(this.title(r.name)))
      .when(r.off, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("Off")))
      .when(!r.off && Boolean(key), (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(key)));
  }

  trashRow(item, t) {
    const id = `trash:${item.id}`, on = this.selected === id;
    return h_flex().id(`mm-${id}`).h(34).flex_none().pl(10).pr(8).gap(9).items_center().rounded(7).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.pick(id); this.msg = null; cx.notify(); })
      .child(image(this.icon(item.name)).size(18).flex_none().opacity(0.45))
      .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.dim).child(item.name));
  }

  section(id, title, items, t, searching) {
    const open = searching || !this.folded[id];
    return v_flex().flex_none()
      .child(h_flex().id(`mm-sec-${id}`).h(32).flex_none().px(8).gap(6).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.folded = { ...this.folded, [id]: !this.folded[id] }; localStorage.setItem("folded", JSON.stringify(this.folded)); cx.notify(); })
        .child(svg(`mods/${M.SELF}/chevron-${open ? "down" : "right"}.svg`).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().text_size(12.5).font_semibold().text_color(t.muted).child(title))
        .child(div().text_size(11.5).text_color(t.dim).child(String(items.length))))
      .when(open, (e) => e.children(items));
  }

  list(t) {
    const q = this.search.value().trim().toLowerCase(), hit = (text) => !q || text.toLowerCase().includes(q), out = [];
    for (const [group, title] of GROUPS) {
      const items = group === "trash"
        ? state().trash.filter((i) => hit(i.name)).map((i) => this.trashRow(i, t))
        : this.rows.filter((r) => r.group === group && (hit(r.name) || hit(this.title(r.name)))).map((r) => this.listRow(r, t));
      if (items.length) out.push(this.section(group, title, items, t, Boolean(q)));
    }
    return v_flex().w(300).flex_none().h_full().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().flex_none().p(10).child(this.input(this.search, t)))
      .child(v_flex().id("mm-list").flex_1().min_h(0).overflow_y_scrollbar().px(8).pb(8).gap(4).children(out)
        .when(!out.length, (e) => e.child(div().p(10).text_size(12.5).text_color(t.dim).child("No mods match the search."))));
  }

  // Green on the right when the mod runs: the first thing to read about it.
  toggle(r, t) {
    const on = !r.off, disabled = Boolean(this.busy);
    const flip = (cx) => {
      if (r.off) return this.job(cx, "Turn on", () => this.turnOn(r.name));
      const lines = this.warnings(r);
      if (!lines.length) return this.job(cx, "Turn off", () => this.turnOff(r.name));
      this.ask = { title: `Turn off ${this.title(r.name)}?`, lines, yes: "Turn off", run: () => this.job(cx, "Turn off", () => this.turnOff(r.name)) };
      cx.notify();
    };
    return h_flex().id("mm-toggle").flex_none().gap(9).items_center().when(!disabled, (e) => e.cursor_pointer())
      .on_click((_e, cx) => { if (!disabled) flip(cx); })
      .child(div().text_size(12.5).text_color(on ? t.foreground : t.dim).child(on ? "On" : "Off"))
      .child(h_flex().w(38).h(22).p(2).flex_none().rounded(11).items_center().when(on, (e) => e.justify_end()).bg(on ? t.ansi2 : t.input)
        .child(div().size(18).rounded(9).bg(on ? t.background : t.muted)));
  }

  hero(icon, title, kind, right, t, { onIcon } = {}) {
    return h_flex().flex_none().gap(14).pb(16).items_center()
      .child(h_flex().id("mm-icon").size(60).flex_none().items_center().justify_center().rounded(13).border_1().border_color(t.border).bg(t.raised)
        .when(Boolean(onIcon), (e) => e.cursor_pointer().tooltip("Change icon").hover((s) => s.border_color(t.accent)).on_click((_e, cx) => onIcon(cx)))
        .child(image(icon).size(34)))
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().truncate().text_size(19).font_semibold().child(title))
        .child(div().truncate().text_size(12.5).text_color(t.muted).child(kind)))
      .child(right);
  }

  usage(r) {
    const parts = [];
    if (r.layouts.length) parts.push(`${r.layouts.length === 1 ? "Layout" : "Layouts"} ${r.layouts.join(", ")}`);
    if (r.mods.length) parts.push(`${r.mods.length === 1 ? "Mod" : "Mods"} ${r.mods.join(", ")}`);
    return parts.join(". ") || "No layout or mod uses it.";
  }

  detail(t) {
    if (this.selected?.startsWith("trash:")) return this.trashDetail(t);
    const r = this.row(this.selected);
    if (!r) return div().flex_1().p(20).text_color(t.dim).child(this.msg ?? "Loading mods…");
    if (this.picking) return this.iconPicker(r, t);
    const from = r.json?.cloned_from?.name, kind = from ? `Copy of ${from}` : KIND[r.group];
    const locked = r.name === M.SELF ? "Always on" : M.CORE.has(r.name) ? "Herdr needs it" : null;
    const action = M.opener(r.name, r.json, this.shown()?.tree), custom = Boolean(this.label(r.name).icon);
    const dirty = this.key.value().trim() !== this.shortcut(r.name);
    const del = (cx) => {
      this.ask = { title: `Delete ${this.title(r.name)}?`, lines: [...(r.off ? [] : this.warnings(r)), "You can bring it back from Trash."], yes: "Delete", run: () => this.job(cx, "Delete", () => this.trash(r.name)) };
      cx.notify();
    };
    return v_flex().id("mm-detail").flex_1().min_w(0).h_full().min_h(0).overflow_y_scrollbar().px(22).py(20)
      .child(this.hero(this.icon(r.name), this.title(r.name), kind,
        locked ? div().flex_none().text_size(12.5).text_color(t.dim).child(locked) : this.toggle(r, t), t,
        { onIcon: (cx) => { this.picking = true; cx.notify(); } }))
      .child(this.setting("Name", h_flex().child(this.input(this.name, t)), t))
      .child(this.setting("Icon", h_flex().gap(8)
        .child(this.button("mm-pick-icon", "Choose icon", (cx) => { this.picking = true; cx.notify(); }, t))
        .when(custom, (e) => e.child(this.button("mm-reset-icon", "Use original", (cx) => this.chooseIcon(null, cx), t))), t))
      .child(this.setting("Shortcut", action
        ? h_flex().gap(8).child(this.input(this.key, t)).when(dirty, (e) => e.child(this.button("mm-key", "Save", (cx) => this.saveKey(cx), t, { primary: true })))
        : div().pt(7).text_size(12.5).text_color(t.dim).child("This mod doesn't open on its own, so it can't have a shortcut."), t))
      .child(this.setting("Used in", div().pt(7).text_size(12.5).text_color(t.foreground).child(this.usage(r)), t))
      .when(r.group !== "native" && r.name !== M.SELF, (e) => e.child(this.setting("Delete", h_flex().child(this.button("mm-del", "Delete mod", del, t, { danger: true })), t, "It goes to Trash, where you can bring it back.")));
  }

  trashDetail(t) {
    const item = state().trash.find((i) => `trash:${i.id}` === this.selected);
    if (!item) return div().flex_1();
    return v_flex().flex_1().min_w(0).h_full().px(22).py(20)
      .child(this.hero(this.icon(item.name), item.name, "In Trash", div(), t))
      .child(this.setting("Restore", h_flex().child(this.button("mm-restore", "Restore mod", (cx) => { this.selected = item.name; this.job(cx, "Restore", () => this.restore(item)); }, t, { primary: true })), t, "It goes back into your layouts and shortcuts."))
      .child(this.setting("Delete for good", h_flex().child(this.button("mm-purge", "Delete for good", (cx) => {
        this.ask = { title: `Delete ${item.name} for good?`, lines: ["You can't bring it back."], yes: "Delete", run: () => { this.selected = null; this.job(cx, "Delete", () => this.purge(item)); } };
        cx.notify();
      }, t, { danger: true })), t));
  }

  iconPicker(r, t) {
    const q = this.iconSearch.value().trim().toLowerCase(), ids = M.PRESETS.filter((id) => id.includes(q)), now = this.icon(r.name), rows = [];
    for (let i = 0; i < ids.length; i += ICON_COLUMNS) rows.push(ids.slice(i, i + ICON_COLUMNS));
    const tile = (id) => {
      const path = `mods/${M.SELF}/icons/${id}.svg`, on = path === now;
      return h_flex().id(`mm-i-${id}`).size(58).flex_none().items_center().justify_center().rounded(9).cursor_pointer().border_1()
        .border_color(on ? t.accent : t.chrome).when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover)).tooltip(id)
        .on_click((_e, cx) => this.chooseIcon(id, cx)).child(image(path).size(28));
    };
    return v_flex().flex_1().min_w(0).h_full().min_h(0).px(22).py(20).gap(14)
      .child(h_flex().flex_none().gap(10).items_center()
        .child(this.button("mm-icon-back", "Back", (cx) => { this.picking = false; cx.notify(); }, t))
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(`Icon for ${this.title(r.name)}`))
        .child(div().w(190).flex_none().flex().child(this.input(this.iconSearch, t))))
      .child(v_flex().id("mm-icons").flex_1().min_h(0).overflow_y_scrollbar().gap(2)
        .children(rows.map((row) => h_flex().flex_none().gap(2).children(row.map(tile))))
        .when(!ids.length, (e) => e.child(div().p(8).text_size(12.5).text_color(t.dim).child("No icons match the search."))));
  }

  confirm(t) {
    const a = this.ask;
    return h_flex().flex_none().px(16).py(13).gap(16).items_center().border_t(1).border_color(t.blocked).bg(t.raised)
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(div().font_semibold().text_size(13.5).text_color(t.foreground).child(a.title))
        .children(a.lines.map((line) => div().text_size(12.5).text_color(t.muted).child(line))))
      .child(this.button("mm-no", "Cancel", (cx) => { this.ask = null; cx.notify(); }, t))
      .child(this.button("mm-yes", a.yes, () => a.run(), t, { danger: true }));
  }

  render() {
    const t = theme();
    return v_flex().id("mod-manager").size_full().min_h(0).bg(t.popover ?? t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().flex_1().min_h(0).child(this.list(t)).child(this.detail(t)))
      .when(Boolean(this.ask), (e) => e.child(this.confirm(t)))
      .when(Boolean(this.msg) && !this.ask, (e) => e.child(h_flex().flex_none().px(16).py(8).border_t(1).border_color(t.border).text_size(12).text_color(t.muted).child(this.busy ? `${this.busy}…` : this.msg)));
  }
}
