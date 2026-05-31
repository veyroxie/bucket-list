// ─── constants ───
const STORAGE_KEY = "bucketList:v1";
const EPIGRAPH_KEY = "bucketList:epigraph";
const PREFS_KEY = "bucketList:prefs";
const ROW_ID = 1;
const ROMAN_MONTHS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];
const OWNER_TOKENS = { me: "me", jaevan: "Jaevan", us: "us" };
const OWNER_VALUES = new Set(["me", "Jaevan", "us"]);
const PRIORITY_TOKENS = { high: "high", med: "medium", medium: "medium", low: "low" };
const PRIORITY_VALUES = new Set(["high", "medium", "low"]);
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
const PRIORITY_LABEL = { high: "essential.", medium: "considered.", low: "someday." };
const SUPABASE_CDN = "https://esm.sh/@supabase/supabase-js@2.45.4";
const SAFE_URL_SCHEMES = /^(https?:|data:image\/)/i;
const AUTOSAVE_MS = 600;

// ─── state ───
const state = {
  items: [],
  filter: { kind: "all", value: null },
  sort: "grouped",
  suggestionId: null,
  supabase: null,
  editMode: "local", // "local" | "view" | "edit"
  expanded: new Set(),
  lastRenderIds: new Set(),
  pendingRemoteSave: null,
  lastSavedHash: "",
};

// ─── id helpers ───
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36);

// ─── inline parser ───
function mergeOwners(seen) {
  if (!seen.length) return "me";
  if (seen.includes("us")) return "us";
  const unique = [...new Set(seen)];
  return unique.length === 1 ? unique[0] : "us";
}

function parsePriority(raw) {
  let priority = "low";
  const cleaned = raw.replace(/!(high|med|medium|low)\b/gi, (_, p) => {
    priority = PRIORITY_TOKENS[p.toLowerCase()];
    return "";
  });
  return { cleaned, priority };
}

function parseTags(raw) {
  const seenOwners = [];
  const tags = [];
  const cleaned = raw.replace(/#([\p{L}\p{N}_-]+)/gu, (_, t) => {
    const lower = t.toLowerCase();
    if (lower in OWNER_TOKENS) seenOwners.push(OWNER_TOKENS[lower]);
    else tags.push(lower);
    return "";
  });
  return { cleaned, owner: mergeOwners(seenOwners), tags };
}

function parseInput(raw) {
  const a = parsePriority(raw);
  const b = parseTags(a.cleaned);
  return {
    title: b.cleaned.replace(/\s+/g, " ").trim(),
    owner: b.owner,
    priority: a.priority,
    tags: [...new Set(b.tags)],
  };
}

// ─── storage layer ───
function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).items ?? [];
  } catch {
    return [];
  }
}

function saveLocal(items) {
  const payload = { items, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

async function loadRemote() {
  const { data, error } = await state.supabase
    .from("bucket_list")
    .select("payload")
    .eq("id", ROW_ID)
    .maybeSingle();
  if (error || !data?.payload) return [];
  return data.payload.items ?? [];
}

async function saveRemote(items) {
  const payload = { items, savedAt: new Date().toISOString() };
  state.lastSavedHash = hashItems(items);
  await state.supabase
    .from("bucket_list")
    .upsert({ id: ROW_ID, payload, updated_at: new Date().toISOString() });
}

function hashItems(items) {
  return JSON.stringify(items.map(i => [i.id, i.title, i.owner, i.priority, i.tags, i.notes, i.coverUrl, i.reflection, i.completedAt, i.order]));
}

const isRemote = () => Boolean(state.supabase);

async function save() {
  if (!isRemote()) { saveLocal(state.items); return; }
  if (state.editMode !== "edit") return;
  state.lastSavedHash = hashItems(state.items);
  if (state.pendingRemoteSave) clearTimeout(state.pendingRemoteSave);
  state.pendingRemoteSave = setTimeout(() => {
    state.pendingRemoteSave = null;
    saveRemote(state.items).catch(() => showStatus("save failed; will retry"));
  }, AUTOSAVE_MS);
}

async function flushPendingSave() {
  if (!state.pendingRemoteSave) return;
  clearTimeout(state.pendingRemoteSave);
  state.pendingRemoteSave = null;
  await saveRemote(state.items).catch(() => {});
}

async function loadItems() {
  const raw = isRemote() ? await loadRemote() : loadLocal();
  state.items = sanitizeItems(raw);
  state.lastSavedHash = hashItems(state.items);
}

function sanitizeString(v, max = 2000) {
  if (typeof v !== "string") return "";
  return v.slice(0, max);
}

function sanitizeUrl(v) {
  const s = sanitizeString(v, 2000).trim();
  if (!s) return "";
  return SAFE_URL_SCHEMES.test(s) ? s : "";
}

function sanitizeTags(v) {
  if (!Array.isArray(v)) return [];
  const cleaned = v
    .filter(t => typeof t === "string")
    .map(t => t.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, "").slice(0, 30))
    .filter(Boolean);
  return [...new Set(cleaned)].slice(0, 20);
}

function sanitizeItem(raw, fallbackOrder) {
  if (!raw || typeof raw !== "object") return null;
  const title = sanitizeString(raw.title, 280).replace(/\s+/g, " ").trim();
  if (!title) return null;
  return {
    id: sanitizeString(raw.id, 40) || newId(),
    title,
    owner: OWNER_VALUES.has(raw.owner) ? raw.owner : "me",
    priority: PRIORITY_VALUES.has(raw.priority) ? raw.priority : "low",
    tags: sanitizeTags(raw.tags),
    notes: sanitizeString(raw.notes, 4000),
    coverUrl: sanitizeUrl(raw.coverUrl),
    reflection: sanitizeString(raw.reflection, 280),
    completedAt: typeof raw.completedAt === "string" ? raw.completedAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    order: typeof raw.order === "number" ? raw.order : fallbackOrder,
  };
}

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it, i) => sanitizeItem(it, i)).filter(Boolean);
}

// ─── CRUD ───
function makeItem(raw) {
  const parsed = parseInput(raw);
  if (!parsed.title) return null;
  return {
    id: newId(),
    title: parsed.title,
    owner: parsed.owner,
    priority: parsed.priority,
    tags: parsed.tags,
    notes: "",
    coverUrl: "",
    reflection: "",
    completedAt: null,
    createdAt: new Date().toISOString(),
    order: state.items.length,
  };
}

async function addItem(raw) {
  const item = makeItem(raw);
  if (!item) return;
  state.items.push(item);
  await save();
  render();
}

async function updateItem(id, patch) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  Object.assign(item, patch);
  await save();
}

async function deleteItem(id) {
  state.items = state.items.filter(i => i.id !== id);
  await save();
  render();
}

async function toggleComplete(id) {
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  const wasComplete = Boolean(item.completedAt);
  item.completedAt = wasComplete ? null : new Date().toISOString();
  if (!wasComplete) state.expanded.add(id);
  await save();
  render();
  if (!wasComplete) focusReflection(id);
}

function focusReflection(id) {
  requestAnimationFrame(() => {
    const node = document.querySelector(`.item[data-id="${id}"] .reflection`);
    if (node) node.focus();
  });
}

function cyclePriority(current) {
  const order = ["low", "medium", "high"];
  return order[(order.indexOf(current) + 1) % 3];
}

function cycleOwner(current) {
  const order = ["me", "Jaevan", "us"];
  return order[(order.indexOf(current) + 1) % 3];
}

// ─── filtering / sorting / grouping ───
function isItemVisible(item) {
  const f = state.filter;
  if (f.kind === "all") return true;
  if (f.kind === "owner") return item.owner === f.value;
  if (f.kind === "tag") return item.tags.includes(f.value);
  return true;
}

function sortItems(items) {
  if (state.sort === "manual") return items.slice().sort((a, b) => a.order - b.order);
  if (state.sort === "added") return items.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (state.sort === "alpha") return items.slice().sort((a, b) => a.title.localeCompare(b.title));
  if (state.sort === "completed-last") {
    return items.slice().sort((a, b) =>
      Number(!!a.completedAt) - Number(!!b.completedAt) || a.order - b.order
    );
  }
  return items.slice().sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.order - b.order
  );
}

function groupByPriority(items) {
  const groups = { high: [], medium: [], low: [] };
  items.forEach(item => groups[item.priority].push(item));
  return groups;
}

// ─── tag chip aggregation ───
function allTags() {
  const seen = new Set();
  state.items.forEach(item => item.tags.forEach(t => seen.add(t)));
  return [...seen].sort();
}

// ─── render: list ───
function formatRomanDate(iso) {
  const d = new Date(iso);
  return `${ROMAN_MONTHS[d.getMonth()]}.${d.getFullYear()}`;
}

function renderTagsInto(container, tags) {
  container.replaceChildren();
  tags.forEach(t => {
    const span = document.createElement("button");
    span.type = "button";
    span.className = "tag";
    span.dataset.tag = t;
    span.textContent = t;
    container.appendChild(span);
  });
}

function fillItemNode(node, item, index) {
  node.dataset.id = item.id;
  node.dataset.priority = item.priority;
  node.dataset.owner = item.owner;
  node.classList.toggle("is-complete", Boolean(item.completedAt));
  node.classList.toggle("is-expanded", state.expanded.has(item.id));
  node.querySelector(".number").textContent = String(index + 1).padStart(2, "0");
  const titleEl = node.querySelector(".title");
  titleEl.textContent = item.title;
  titleEl.contentEditable = canEdit() ? "true" : "false";
  node.querySelector(".owner").textContent = item.owner;
  renderTagsInto(node.querySelector(".tag-list"), item.tags);
  node.querySelector(".marginalia").textContent = item.completedAt ? formatRomanDate(item.completedAt) : "";
  fillDetail(node, item);
}

function fillDetail(node, item) {
  const detail = node.querySelector(".detail");
  detail.hidden = !state.expanded.has(item.id);
  const notes = node.querySelector(".notes");
  notes.value = item.notes ?? "";
  notes.readOnly = !canEdit();
  const coverInput = node.querySelector(".cover-url");
  coverInput.value = item.coverUrl ?? "";
  coverInput.readOnly = !canEdit();
  const cover = node.querySelector(".cover");
  const safe = sanitizeUrl(item.coverUrl);
  if (safe) {
    cover.hidden = false;
    cover.style.backgroundImage = `url("${encodeURI(safe)}")`;
  } else {
    cover.hidden = true;
    cover.style.backgroundImage = "";
  }
  fillReflection(node, item);
}

function fillReflection(node, item) {
  const r = node.querySelector(".reflection");
  const shown = node.querySelector(".reflection-shown");
  if (item.completedAt) {
    r.hidden = Boolean(item.reflection);
    r.value = item.reflection ?? "";
    shown.hidden = !item.reflection;
    shown.textContent = item.reflection ? `"${item.reflection}"` : "";
  } else {
    r.hidden = true;
    shown.hidden = true;
  }
}

function buildItemNode(item, index) {
  const tmpl = document.getElementById("item-template");
  const node = tmpl.content.firstElementChild.cloneNode(true);
  fillItemNode(node, item, index);
  if (!state.lastRenderIds.has(item.id)) node.classList.add("is-entering");
  if (!canEdit()) node.draggable = false;
  return node;
}

function renderGroupHeader(label) {
  const h = document.createElement("li");
  h.className = "group-header";
  h.textContent = label;
  return h;
}

function renderList() {
  const listEl = document.getElementById("list");
  const visible = state.items.filter(isItemVisible);
  const sorted = sortItems(visible);
  document.getElementById("empty").hidden = state.items.length > 0;
  listEl.innerHTML = "";
  if (state.sort === "grouped") renderGrouped(listEl, sorted);
  else sorted.forEach((item, i) => listEl.appendChild(buildItemNode(item, i)));
}

function renderGrouped(listEl, sorted) {
  const groups = groupByPriority(sorted);
  let n = 0;
  ["high", "medium", "low"].forEach(p => {
    if (!groups[p].length) return;
    listEl.appendChild(renderGroupHeader(PRIORITY_LABEL[p]));
    groups[p].forEach(item => {
      listEl.appendChild(buildItemNode(item, n));
      n++;
    });
  });
}

// ─── render: chips / stats ───
function renderTagChips() {
  const wrap = document.getElementById("tag-chips");
  wrap.innerHTML = "";
  allTags().forEach(t => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.filter = "tag";
    b.dataset.value = t;
    b.textContent = `#${t}`;
    if (state.filter.kind === "tag" && state.filter.value === t) b.classList.add("is-active");
    wrap.appendChild(b);
  });
  syncActiveChip();
}

function syncActiveChip() {
  document.querySelectorAll("#filters .chip").forEach(chip => {
    const matches = state.filter.kind === chip.dataset.filter &&
      (state.filter.value ?? "all") === (chip.dataset.value ?? "all");
    chip.classList.toggle("is-active", matches);
  });
}

function ownerCount(owner) {
  return state.items.filter(i => i.owner === owner).length;
}

function renderStats() {
  const total = state.items.length;
  const done = state.items.filter(i => i.completedAt).length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("count").textContent = `${done} of ${total} complete`;
  document.getElementById("percent").textContent = `${pct}%`;
  document.getElementById("bar-fill").style.width = `${pct}%`;
  document.getElementById("substats").textContent =
    `me ${ownerCount("me")} / Jaevan ${ownerCount("Jaevan")} / us ${ownerCount("us")}`;
}

function render() {
  pruneStaleSuggestion();
  pruneStaleExpanded();
  const first = captureRects();
  renderList();
  renderStats();
  renderTagChips();
  renderSuggestion();
  requestAnimationFrame(() => playFlip(first));
  state.lastRenderIds = new Set(state.items.map(i => i.id));
}

function pruneStaleSuggestion() {
  if (!state.suggestionId) return;
  const item = state.items.find(i => i.id === state.suggestionId);
  if (!item || item.completedAt) state.suggestionId = null;
}

function pruneStaleExpanded() {
  const live = new Set(state.items.map(i => i.id));
  [...state.expanded].forEach(id => { if (!live.has(id)) state.expanded.delete(id); });
}

function renderSuggestion() {
  const box = document.getElementById("suggestion");
  if (!state.suggestionId) { box.hidden = true; return; }
  const item = state.items.find(i => i.id === state.suggestionId);
  if (!item) { box.hidden = true; return; }
  box.hidden = false;
  box.querySelector(".suggestion-item").textContent = item.title;
}

// ─── FLIP ───
function captureRects() {
  const map = new Map();
  document.querySelectorAll(".item").forEach(el => {
    map.set(el.dataset.id, el.getBoundingClientRect());
  });
  return map;
}

function playFlip(firstRects) {
  document.querySelectorAll(".item").forEach(el => {
    const first = firstRects.get(el.dataset.id);
    if (!first) return;
    const last = el.getBoundingClientRect();
    const dy = first.top - last.top;
    if (Math.abs(dy) < 1) return;
    el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
      { duration: 280, easing: "cubic-bezier(0.4,0,0.2,1)" }
    );
  });
}

// ─── composer ───
function highlightDuplicate(query) {
  document.querySelectorAll(".item").forEach(el => el.classList.remove("is-matched-hint"));
  if (!query) return;
  const q = query.toLowerCase();
  const match = state.items.find(i =>
    i.title.toLowerCase().includes(q) && q.length >= 3 && !i.completedAt
  );
  if (!match) return;
  const el = document.querySelector(`.item[data-id="${match.id}"]`);
  if (el) el.classList.add("is-matched-hint");
}

function handleAddSubmit(e) {
  e.preventDefault();
  const input = document.getElementById("add-input");
  const raw = input.value;
  if (!raw.trim()) return;
  addItem(raw);
  input.value = "";
  highlightDuplicate("");
}

function handleAddInput(e) {
  const v = e.target.value;
  const hint = document.getElementById("composer-hint");
  if (!v) { hint.hidden = true; highlightDuplicate(""); return; }
  const parsed = parseInput(v);
  const parts = [];
  if (parsed.owner !== "me") parts.push(parsed.owner);
  if (parsed.priority !== "low") parts.push(parsed.priority);
  parsed.tags.forEach(t => parts.push(`#${t}`));
  hint.textContent = parts.length ? parts.join(" · ") : "";
  hint.hidden = !parts.length;
  highlightDuplicate(parsed.title);
}

// ─── filters ───
function handleFilterClick(e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const kind = chip.dataset.filter;
  const value = chip.dataset.value;
  const same = state.filter.kind === kind && (state.filter.value ?? "all") === (value ?? "all");
  if (same && kind !== "all") state.filter = { kind: "all", value: null };
  else state.filter = { kind, value: kind === "all" ? null : value };
  savePrefs();
  render();
}

function filterByTag(tag) {
  state.filter = { kind: "tag", value: tag };
  savePrefs();
  render();
}

// ─── item interactions ───
function handleListClick(e) {
  const tagBtn = e.target.closest(".tag");
  if (tagBtn?.dataset.tag) { filterByTag(tagBtn.dataset.tag); return; }
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest(".check")) return handleCheck(id);
  if (e.target.closest(".expand")) return handleExpand(id);
  if (e.target.closest(".delete")) return handleDelete(id);
  if (e.target.closest(".priority-cycle")) return handlePriorityCycle(id);
  if (e.target.closest(".owner-cycle")) return handleOwnerCycle(id);
}

function handleDelete(id) {
  if (!canEdit()) return;
  deleteItem(id);
}

function handleCheck(id) {
  if (!canEdit()) return;
  toggleComplete(id);
}

function handleExpand(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  renderList();
}

async function handlePriorityCycle(id) {
  if (!canEdit()) return;
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  await updateItem(id, { priority: cyclePriority(item.priority) });
  render();
}

async function handleOwnerCycle(id) {
  if (!canEdit()) return;
  const item = state.items.find(i => i.id === id);
  if (!item) return;
  await updateItem(id, { owner: cycleOwner(item.owner) });
  render();
}

// ─── inline editing of title / notes / cover / reflection ───
function bindInlineEdits(root) {
  root.addEventListener("blur", handleInlineBlur, true);
  root.addEventListener("input", handleInlineInput, true);
  root.addEventListener("keydown", handleInlineKeydown, true);
}

function handleInlineInput(e) {
  if (!canEdit()) return;
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.classList.contains("notes")) updateItem(id, { notes: sanitizeString(e.target.value, 4000) });
  if (e.target.classList.contains("title")) updateTitleLive(id, e.target);
}

function updateTitleLive(id, el) {
  const next = sanitizeString(el.textContent, 280).replace(/\s+/g, " ").trim();
  if (!next) return;
  updateItem(id, { title: next });
}

function handleInlineBlur(e) {
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.classList.contains("title")) saveTitle(id, e.target);
  if (e.target.classList.contains("cover-url")) handleCoverUrlBlur(id, e.target);
  if (e.target.classList.contains("reflection")) handleReflectionBlur(id, e.target);
}

function saveTitle(id, el) {
  if (!canEdit()) return;
  const next = sanitizeString(el.textContent, 280).replace(/\s+/g, " ").trim();
  if (!next) { deleteItem(id); return; }
  updateItem(id, { title: next });
}

function handleCoverUrlBlur(id, el) {
  if (!canEdit()) return;
  updateItem(id, { coverUrl: el.value.trim() });
  const node = document.querySelector(`.item[data-id="${id}"]`);
  const item = state.items.find(i => i.id === id);
  if (node && item) fillDetail(node, item);
}

function handleReflectionBlur(id, el) {
  if (!canEdit()) return;
  const text = el.value.trim();
  updateItem(id, { reflection: text });
  const node = document.querySelector(`.item[data-id="${id}"]`);
  const item = state.items.find(i => i.id === id);
  if (node && item) fillReflection(node, item);
}

function handleInlineKeydown(e) {
  const t = e.target;
  if (e.key === "Enter" && (t.classList.contains("title") || t.classList.contains("reflection") || t.classList.contains("cover-url"))) {
    e.preventDefault();
    t.blur();
  }
  if (e.key === "Escape") t.blur();
}

// ─── drag and drop ───
let dragId = null;

function canDragNow() {
  return canEdit() && state.sort === "manual" && state.filter.kind === "all";
}

function handleDragStart(e) {
  if (e.target.closest(".title, .notes, .cover-url, .reflection, button, input, textarea")) {
    e.preventDefault();
    return;
  }
  const item = e.target.closest(".item");
  if (!item || !canDragNow()) { e.preventDefault(); return; }
  dragId = item.dataset.id;
  item.classList.add("is-dragging");
  e.dataTransfer.effectAllowed = "move";
}

function handleDragOver(e) {
  const item = e.target.closest(".item");
  if (!item || !dragId || item.dataset.id === dragId) return;
  e.preventDefault();
  document.querySelectorAll(".item.is-drop-target").forEach(el => el.classList.remove("is-drop-target"));
  item.classList.add("is-drop-target");
}

async function handleDrop(e) {
  e.preventDefault();
  const target = e.target.closest(".item");
  if (!target || !dragId || target.dataset.id === dragId) return cleanupDrag();
  reorderItems(dragId, target.dataset.id);
  cleanupDrag();
  await save();
  render();
}

function reorderItems(fromId, toId) {
  const from = state.items.findIndex(i => i.id === fromId);
  const to = state.items.findIndex(i => i.id === toId);
  if (from < 0 || to < 0 || from === to) return;
  const [moved] = state.items.splice(from, 1);
  const insertAt = from < to ? to - 1 : to;
  state.items.splice(insertAt, 0, moved);
  state.items.forEach((item, i) => { item.order = i; });
}

function cleanupDrag() {
  document.querySelectorAll(".item.is-dragging, .item.is-drop-target").forEach(el =>
    el.classList.remove("is-dragging", "is-drop-target")
  );
  dragId = null;
}

// ─── epigraph ───
function loadEpigraph() {
  const saved = localStorage.getItem(EPIGRAPH_KEY);
  if (saved) document.getElementById("epigraph").textContent = saved;
}

function bindEpigraph() {
  const el = document.getElementById("epigraph");
  el.contentEditable = "true";
  el.addEventListener("blur", () => {
    const text = el.textContent.replace(/\s+/g, " ").trim();
    el.textContent = text;
    if (text) localStorage.setItem(EPIGRAPH_KEY, text);
  });
  el.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); el.blur(); }
  });
}

// ─── one for today ───
function pickSuggestion() {
  const pool = state.items.filter(i => !i.completedAt);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showSuggestion() {
  const item = pickSuggestion();
  state.suggestionId = item ? item.id : null;
  renderSuggestion();
}

// ─── sort cycling ───
const SORT_MODES = ["grouped", "manual", "added", "alpha", "completed-last"];
const SORT_LABELS = {
  grouped: "grouped",
  manual: "manual",
  added: "by date added",
  alpha: "alphabetical",
  "completed-last": "completed last",
};

function syncSortLabel() {
  document.getElementById("sort-link").textContent = SORT_LABELS[state.sort] ?? "grouped";
}

function cycleSort() {
  const i = SORT_MODES.indexOf(state.sort);
  state.sort = SORT_MODES[(i + 1) % SORT_MODES.length];
  syncSortLabel();
  savePrefs();
  render();
}

// ─── prefs ───
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (SORT_MODES.includes(p.sort)) state.sort = p.sort;
    if (p.filter && typeof p.filter === "object") state.filter = p.filter;
  } catch {}
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ sort: state.sort, filter: state.filter }));
}

// ─── inline status messages ───
let statusTimer = null;
function showStatus(text) {
  const el = document.getElementById("status-line");
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

// ─── export / import ───
function downloadJson() {
  const blob = new Blob(
    [JSON.stringify({ items: state.items, savedAt: new Date().toISOString() }, null, 2)],
    { type: "application/json" }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `bucket-list-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function handleImportFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { showStatus("that file isn't valid JSON."); e.target.value = ""; return; }
  const cleaned = sanitizeItems(parsed?.items);
  if (!cleaned.length) { showStatus("no usable items in that file."); e.target.value = ""; return; }
  if (state.items.length) {
    showImportConfirm(cleaned);
  } else {
    await applyImport(cleaned);
  }
  e.target.value = "";
}

async function applyImport(cleaned) {
  state.items = cleaned;
  await save();
  render();
  showStatus(`imported ${cleaned.length} item${cleaned.length === 1 ? "" : "s"}.`);
}

function showImportConfirm(cleaned) {
  const node = document.getElementById("import-confirm");
  if (!node) return;
  node.hidden = false;
  node.dataset.count = String(cleaned.length);
  node.querySelector(".import-confirm-text").textContent =
    `replace ${state.items.length} item${state.items.length === 1 ? "" : "s"} with ${cleaned.length} imported?`;
  node.querySelector(".import-yes").onclick = async () => {
    node.hidden = true;
    await applyImport(cleaned);
  };
  node.querySelector(".import-no").onclick = () => { node.hidden = true; };
}

// ─── supabase + passphrase gate ───
async function setupSupabase() {
  const cfg = window.BUCKET_CONFIG;
  if (!cfg?.supabaseUrl || !cfg?.supabaseAnonKey) return null;
  try {
    const { createClient } = await import(SUPABASE_CDN);
    return createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: { persistSession: true, storageKey: "bucketList:auth" },
    });
  } catch (err) {
    showStatus("couldn't connect to the shared store. falling back to local.");
    return null;
  }
}

async function syncEditModeFromSession() {
  if (!state.supabase) { state.editMode = "local"; return; }
  const { data } = await state.supabase.auth.getSession();
  state.editMode = data.session ? "edit" : "view";
}

function applyEditModeUi() {
  document.body.classList.toggle("is-view-only", state.editMode === "view");
  const colophon = document.getElementById("colophon");
  const link = document.getElementById("gate-link");
  const sep = document.querySelector(".gate-sep");
  if (state.editMode === "local") {
    link.hidden = true;
    sep.hidden = true;
    colophon.textContent = "a small private place. lives in your browser.";
    return;
  }
  link.hidden = false;
  sep.hidden = false;
  link.textContent = state.editMode === "edit" ? "lock editing" : "unlock editing";
  colophon.textContent = state.editMode === "edit"
    ? "editing unlocked. changes save instantly."
    : "view only. unlock to edit.";
}

const canEdit = () => state.editMode === "local" || state.editMode === "edit";

async function handleGateSubmit(e) {
  e.preventDefault();
  const cfg = window.BUCKET_CONFIG;
  const input = document.getElementById("gate-input");
  const err = document.getElementById("gate-error");
  err.hidden = true;
  const { error } = await state.supabase.auth.signInWithPassword({
    email: cfg.sharedEmail,
    password: input.value,
  });
  if (error) { err.hidden = false; input.select(); return; }
  document.getElementById("gate-form").hidden = true;
  input.value = "";
  state.editMode = "edit";
  applyEditModeUi();
  await loadItems();
  render();
}

async function handleGateLink() {
  if (state.editMode === "edit") {
    await flushPendingSave();
    await state.supabase.auth.signOut();
    state.editMode = "view";
    applyEditModeUi();
    render();
    return;
  }
  document.getElementById("gate-form").hidden = false;
  document.getElementById("gate-input").focus();
}

function handleGateCancel() {
  const form = document.getElementById("gate-form");
  const input = document.getElementById("gate-input");
  const err = document.getElementById("gate-error");
  input.value = "";
  err.hidden = true;
  form.hidden = true;
}

function subscribeRemoteChanges() {
  if (!state.supabase) return;
  state.supabase
    .channel("bucket_list_changes")
    .on("postgres_changes", { event: "*", schema: "public", table: "bucket_list" }, async (payload) => {
      const remoteHash = hashItems(sanitizeItems(payload?.new?.payload?.items));
      if (remoteHash === state.lastSavedHash) return;
      await loadItems();
      render();
    })
    .subscribe();
}

// ─── wiring ───
function bindEvents() {
  document.getElementById("add-form").addEventListener("submit", handleAddSubmit);
  document.getElementById("add-input").addEventListener("input", handleAddInput);
  document.getElementById("filters").addEventListener("click", handleFilterClick);
  bindList();
  document.getElementById("today-link").addEventListener("click", showSuggestion);
  document.getElementById("sort-link").addEventListener("click", cycleSort);
  document.getElementById("export-link").addEventListener("click", downloadJson);
  document.getElementById("import-link").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", handleImportFile);
  document.getElementById("gate-link").addEventListener("click", handleGateLink);
  document.getElementById("gate-form").addEventListener("submit", handleGateSubmit);
  document.getElementById("gate-cancel").addEventListener("click", handleGateCancel);
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("beforeunload", () => flushPendingSave());
}

function bindList() {
  const list = document.getElementById("list");
  list.addEventListener("click", handleListClick);
  list.addEventListener("dragstart", handleDragStart);
  list.addEventListener("dragover", handleDragOver);
  list.addEventListener("drop", handleDrop);
  list.addEventListener("dragend", cleanupDrag);
  list.addEventListener("paste", handlePaste, true);
  bindInlineEdits(list);
}

function handlePaste(e) {
  if (!e.target.classList.contains("title")) return;
  e.preventDefault();
  const text = (e.clipboardData?.getData("text/plain") ?? "").replace(/\s+/g, " ").trim();
  document.execCommand("insertText", false, text);
}

function handleGlobalKeydown(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "k") {
    e.preventDefault();
    document.getElementById("add-input").focus();
  }
}

// ─── boot ───
async function boot() {
  loadPrefs();
  state.supabase = await setupSupabase();
  await syncEditModeFromSession();
  applyEditModeUi();
  syncSortLabel();
  loadEpigraph();
  bindEpigraph();
  bindEvents();
  await loadItems();
  render();
  subscribeRemoteChanges();
}

boot();
