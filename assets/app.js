// ─── constants ───
const STORAGE_KEY = "bucketList:v1";
const PLACES_STORAGE_KEY = "placesList:v1";
const EPIGRAPH_KEY = "bucketList:epigraph";
const PREFS_KEY = "bucketList:prefs";
const VIEW_KEY = "bucketList:view";
const ROW_ID = 1;
const DEFAULT_COUNTRY = "malaysia";
const MONTHS_SHORT = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
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
  // shared
  view: "list",         // "list" | "places"
  supabase: null,
  editMode: "local",    // "local" | "view" | "edit"

  // list view
  items: [],
  filter: { kind: "all", value: null },
  sort: "grouped",
  expanded: new Set(),
  lastRenderIds: new Set(),
  suggestionId: null,
  archiveOpen: false,
  pendingRemoteSave: null,
  lastSavedHash: "",

  // places view
  places: [],
  locations: { countries: [], cities: {} },
  drillCountry: null,
  placesFilter: { kind: "all", value: null },
  placesExpanded: new Set(),
  placesLastRenderIds: new Set(),
  placesArchiveOpen: false,
  pendingRemoteSavePlaces: null,
  lastSavedHashPlaces: "",
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
    x: typeof raw.x === "number" ? clampX(raw.x) : null,
    y: typeof raw.y === "number" ? clampY(raw.y) : null,
  };
}

function clampX(n) { return Math.max(0, Math.min(420, n)); }
function clampY(n) { return Math.max(0, Math.min(CANVAS_MAX_Y, n)); }

function sanitizeItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it, i) => sanitizeItem(it, i)).filter(Boolean);
}

// ─── CRUD ───
function makeItem(raw) {
  const parsed = parseInput(raw);
  if (!parsed.title) return null;
  const pos = autoPositionFor(state.items);
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
    x: pos.x,
    y: pos.y,
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
  if (!wasComplete) {
    state.expanded.add(id);
    state.archiveOpen = true;
    savePrefs();
  }
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
  if (state.sort === "alpha") return items.slice().sort((a, b) => (a.title ?? a.name).localeCompare(b.title ?? b.name));
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
  return `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(-2)}`;
}
const formatDate = formatRomanDate;

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
  if (!canEdit() || item.completedAt) node.draggable = false;
  return node;
}

function renderGroupHeader(label) {
  const h = document.createElement("li");
  h.className = "group-header";
  h.textContent = label;
  return h;
}

// ─── canvas + done-zone rendering ───
const CARD_W = 220;
const CARD_H = 110;
const COL_STEP = 240;
const ROW_STEP = 130;
const CANVAS_MAX_Y = 600;

function autoPositionFor(existing) {
  const placed = existing.filter(it => it.x != null && it.y != null);
  for (let y = 8; y <= CANVAS_MAX_Y; y += ROW_STEP) {
    for (let x = 10; x <= 420; x += COL_STEP) {
      if (!collidesAt(x, y, placed)) return { x, y };
    }
  }
  return { x: 10 + Math.random() * 240, y: 10 + Math.random() * CANVAS_MAX_Y };
}

function collidesAt(x, y, items) {
  return items.some(it =>
    Math.abs(it.x - x) < CARD_W - 20 && Math.abs(it.y - y) < CARD_H - 10
  );
}

function ensureItemPositions() {
  state.items.forEach(item => {
    if (item.x == null || item.y == null) {
      const pos = autoPositionFor(state.items);
      item.x = pos.x;
      item.y = pos.y;
    }
  });
}

function ensurePlacePositionsForCountry(country) {
  state.places.filter(p => p.country === country).forEach(place => {
    if (place.x == null || place.y == null) {
      const pos = autoPositionFor(state.places.filter(p => p.country === country));
      place.x = pos.x;
      place.y = pos.y;
    }
  });
}

function renderList() {
  ensureItemPositions();
  const canvas = document.getElementById("list");
  const visible = state.items.filter(isItemVisible);
  const active = visible.filter(i => !i.completedAt);
  const archived = visible.filter(i => i.completedAt);
  document.getElementById("empty").hidden = state.items.length > 0;
  canvas.replaceChildren();
  active.forEach(item => canvas.appendChild(buildCardNode(item, "item")));
  growCanvas(canvas, active);
  renderItemsDoneZone(archived);
}

function renderItemsDoneZone(archived) {
  const wrap = document.getElementById("archive");
  const listEl = document.getElementById("archive-list");
  listEl.replaceChildren();
  if (!archived.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  document.getElementById("archive-count").textContent = String(archived.length);
  const ordered = archived.slice().sort((a, b) =>
    (b.completedAt ?? "").localeCompare(a.completedAt ?? "")
  );
  ordered.forEach(item => listEl.appendChild(buildChipNode(item, "item")));
}

function growCanvas(canvas, items) {
  const maxAllowed = CANVAS_MAX_Y + CARD_H + 40;
  if (!items.length) { canvas.style.minHeight = "480px"; return; }
  const maxY = Math.max(...items.map(i => i.y ?? 0));
  const wanted = Math.max(480, Math.min(maxY + CARD_H + 40, maxAllowed));
  canvas.style.minHeight = wanted + "px";
}

function buildCardNode(item, kind) {
  const tmplId = kind === "place" ? "place-card-template" : "card-template";
  const tmpl = document.getElementById(tmplId);
  const node = tmpl.content.firstElementChild.cloneNode(true);
  fillCardNode(node, item, kind);
  const lastIds = kind === "place" ? state.placesLastRenderIds : state.lastRenderIds;
  if (!lastIds.has(item.id)) node.classList.add("is-entering");
  if (!canEdit()) node.style.cursor = "default";
  return node;
}

function fillCardNode(node, item, kind) {
  node.dataset.id = item.id;
  node.dataset.priority = item.priority;
  node.dataset.owner = item.owner;
  node.dataset.kind = kind;
  node.style.left = (item.x ?? 10) + "px";
  node.style.top = (item.y ?? 10) + "px";
  const titleEl = node.querySelector(".title");
  titleEl.textContent = kind === "place" ? item.name : item.title;
  titleEl.contentEditable = canEdit() ? "true" : "false";
  node.querySelector(".owner").textContent = item.owner;
  renderTagsInto(node.querySelector(".tag-list"), item.tags);
  if (kind === "place") fillPlaceCardAddress(node, item);
}

function fillPlaceCardAddress(node, place) {
  const row = node.querySelector(".address-row");
  const link = node.querySelector(".address-link");
  const text = node.querySelector(".address-text");
  const localised = [place.address, place.district, place.city, place.country].filter(Boolean).join(", ");
  const query = (place.address ? localised : `${place.name}, ${[place.district, place.city, place.country].filter(Boolean).join(", ")}`).trim();
  if (!query) { row.hidden = true; return; }
  row.hidden = false;
  link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  text.textContent = [place.district, place.city].filter(Boolean).join(", ") || "find on maps";
}

function buildChipNode(item, kind) {
  const tmpl = document.getElementById("chip-template");
  const node = tmpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = item.id;
  node.dataset.kind = kind;
  const label = kind === "place" ? item.name : item.title;
  node.querySelector(".chip-title").textContent = label;
  return node;
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
  if (state.view === "places") return renderPlacesView();
  renderListView();
}

function renderListView() {
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
  if (state.view === "places") addPlace(raw);
  else addItem(raw);
  input.value = "";
  highlightDuplicate("");
  document.getElementById("composer-hint").hidden = true;
  hideSuggestStrip();
}

function handleAddInput(e) {
  const v = e.target.value;
  const hint = document.getElementById("composer-hint");
  if (!v) { hint.hidden = true; highlightDuplicate(""); hideSuggestStrip(); return; }
  if (state.view === "places") {
    const parsed = parsePlace(v);
    const segs = [parsed.country];
    if (parsed.city) segs.push(parsed.city);
    if (parsed.district) segs.push(parsed.district);
    const parts = [segs.join(" · ")];
    if (parsed.owner !== "me") parts.push(parsed.owner);
    if (parsed.priority !== "low") parts.push(parsed.priority);
    parsed.tags.forEach(t => parts.push(`#${t}`));
    hint.textContent = parts.join("   ");
    hint.hidden = false;
    renderSuggestStrip();
    return;
  }
  const parsed = parseInput(v);
  const parts = [];
  if (parsed.owner !== "me") parts.push(parsed.owner);
  if (parsed.priority !== "low") parts.push(parsed.priority);
  parsed.tags.forEach(t => parts.push(`#${t}`));
  hint.textContent = parts.length ? parts.join(" · ") : "";
  hint.hidden = !parts.length;
  highlightDuplicate(parsed.title);
  hideSuggestStrip();
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
  if (e.target.closest(".delete-x")) return softDeleteItem(id);
  if (e.target.closest(".check")) return handleCheck(id);
  if (e.target.closest(".expand")) return handleExpand(id);
  if (e.target.closest(".delete")) return softDeleteItem(id);
  if (e.target.closest(".priority-cycle")) return handlePriorityCycle(id);
  if (e.target.closest(".owner-cycle")) return handleOwnerCycle(id);
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
const SORT_MODES = ["grouped", "manual", "added", "alpha"];
const SORT_LABELS = {
  grouped: "grouped",
  manual: "manual",
  added: "by date added",
  alpha: "alphabetical",
};

function syncSortLabel() {
  document.getElementById("sort-link").textContent = "tidy";
}

async function tidyLayout() {
  if (!canEdit()) return;
  if (state.view === "places" && state.drillCountry) {
    const places = state.places.filter(p => p.country === state.drillCountry && !p.visitedAt);
    layoutInGrid(places);
    await savePlaces();
  } else if (state.view === "list") {
    const items = state.items.filter(i => !i.completedAt);
    layoutInGrid(items);
    await save();
  }
  render();
}

function layoutInGrid(items) {
  items.forEach((item, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    item.x = 10 + col * COL_STEP;
    item.y = 10 + row * ROW_STEP;
  });
}

// ─── prefs ───
function loadPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return;
    const p = JSON.parse(raw);
    if (SORT_MODES.includes(p.sort)) state.sort = p.sort;
    if (p.filter && typeof p.filter === "object") state.filter = p.filter;
    if (typeof p.archiveOpen === "boolean") state.archiveOpen = p.archiveOpen;
    if (typeof p.placesArchiveOpen === "boolean") state.placesArchiveOpen = p.placesArchiveOpen;
    if (p.placesFilter && typeof p.placesFilter === "object") state.placesFilter = p.placesFilter;
  } catch {}
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify({
    sort: state.sort,
    filter: state.filter,
    archiveOpen: state.archiveOpen,
    placesArchiveOpen: state.placesArchiveOpen,
    placesFilter: state.placesFilter,
  }));
}

// ─── inline status messages ───
let statusTimer = null;
function showStatus(text, action) {
  const el = document.getElementById("status-line");
  if (!el) return;
  el.replaceChildren();
  el.append(document.createTextNode(text));
  if (action) {
    el.append(document.createTextNode(" — "));
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "status-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => { hideStatus(); action.onClick(); });
    el.append(btn);
  }
  el.hidden = false;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}

function hideStatus() {
  const el = document.getElementById("status-line");
  if (el) el.hidden = true;
  if (statusTimer) clearTimeout(statusTimer);
}

// ─── soft delete + undo ───
async function softDeleteItem(id) {
  if (!canEdit()) return;
  const idx = state.items.findIndex(i => i.id === id);
  if (idx < 0) return;
  const [removed] = state.items.splice(idx, 1);
  state.expanded.delete(id);
  await save();
  render();
  showStatus(`deleted "${trunc(removed.title, 40)}"`, {
    label: "undo",
    onClick: () => undoItemDelete(removed, idx),
  });
}

async function undoItemDelete(item, idx) {
  state.items.splice(Math.min(idx, state.items.length), 0, item);
  state.items.forEach((it, i) => { it.order = i; });
  await save();
  render();
}

async function softDeletePlace(id) {
  if (!canEdit()) return;
  const idx = state.places.findIndex(p => p.id === id);
  if (idx < 0) return;
  const [removed] = state.places.splice(idx, 1);
  state.placesExpanded.delete(id);
  await savePlaces();
  render();
  showStatus(`deleted "${trunc(removed.name, 40)}"`, {
    label: "undo",
    onClick: () => undoPlaceDelete(removed, idx),
  });
}

async function undoPlaceDelete(place, idx) {
  state.places.splice(Math.min(idx, state.places.length), 0, place);
  state.places.forEach((p, i) => { p.order = i; });
  await savePlaces();
  render();
}

function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

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
    .on("postgres_changes", { event: "*", schema: "public", table: "places_list" }, async (payload) => {
      const remoteHash = hashItems(sanitizePlaces(payload?.new?.payload?.items));
      if (remoteHash === state.lastSavedHashPlaces) return;
      await loadPlaces();
      render();
    })
    .subscribe();
}

// ═══════════════════════════════════════════════════════════════════
// PLACES MODE
// ═══════════════════════════════════════════════════════════════════

// ─── places: parser ───
const LOC_TOKEN_RE = /@([\p{L}\p{N}-]+)(?:\.([\p{L}\p{N}-]+)(?:\.([\p{L}\p{N}-]+))?)?/gu;
const normalizeLoc = s => s ? s.toLowerCase().replace(/-/g, " ").trim() : "";

function parseLocation(raw) {
  let country = null, city = "", district = "";
  const cleaned = raw.replace(LOC_TOKEN_RE, (_, c, ci, d) => {
    country = normalizeLoc(c);
    city = normalizeLoc(ci);
    district = normalizeLoc(d);
    return "";
  });
  return { cleaned, country, city, district };
}

function parsePlace(raw) {
  const a = parsePriority(raw);
  const b = parseLocation(a.cleaned);
  const c = parseTags(b.cleaned);
  const fallback = state.drillCountry || DEFAULT_COUNTRY;
  return {
    name: c.cleaned.replace(/\s+/g, " ").trim(),
    country: b.country || fallback,
    city: b.city,
    district: b.district,
    owner: c.owner,
    priority: a.priority,
    tags: [...new Set(c.tags)],
  };
}

// ─── places: storage ───
function loadPlacesLocal() {
  try {
    const raw = localStorage.getItem(PLACES_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw).items ?? [];
  } catch { return []; }
}

function savePlacesLocal(places) {
  const payload = { items: places, savedAt: new Date().toISOString() };
  localStorage.setItem(PLACES_STORAGE_KEY, JSON.stringify(payload));
}

async function loadPlacesRemote() {
  const { data, error } = await state.supabase
    .from("places_list").select("payload").eq("id", ROW_ID).maybeSingle();
  if (error || !data?.payload) return [];
  return data.payload.items ?? [];
}

async function savePlacesRemote(places) {
  const payload = { items: places, savedAt: new Date().toISOString() };
  state.lastSavedHashPlaces = hashItems(places);
  await state.supabase
    .from("places_list")
    .upsert({ id: ROW_ID, payload, updated_at: new Date().toISOString() });
}

async function savePlaces() {
  if (!isRemote()) { savePlacesLocal(state.places); return; }
  if (state.editMode !== "edit") return;
  state.lastSavedHashPlaces = hashItems(state.places);
  if (state.pendingRemoteSavePlaces) clearTimeout(state.pendingRemoteSavePlaces);
  state.pendingRemoteSavePlaces = setTimeout(() => {
    state.pendingRemoteSavePlaces = null;
    savePlacesRemote(state.places).catch(() => showStatus("save failed; will retry"));
  }, AUTOSAVE_MS);
}

async function flushPendingSavePlaces() {
  if (!state.pendingRemoteSavePlaces) return;
  clearTimeout(state.pendingRemoteSavePlaces);
  state.pendingRemoteSavePlaces = null;
  await savePlacesRemote(state.places).catch(() => {});
}

async function loadPlaces() {
  const raw = isRemote() ? await loadPlacesRemote() : loadPlacesLocal();
  state.places = sanitizePlaces(raw);
  state.lastSavedHashPlaces = hashItems(state.places);
}

// ─── places: sanitize ───
function sanitizePlace(raw, fallbackOrder) {
  if (!raw || typeof raw !== "object") return null;
  const name = sanitizeString(raw.name, 280).replace(/\s+/g, " ").trim();
  if (!name) return null;
  const country = sanitizeString(raw.country, 80).toLowerCase().replace(/\s+/g, " ").trim() || DEFAULT_COUNTRY;
  return {
    id: sanitizeString(raw.id, 40) || newId(),
    name, country,
    city: sanitizeString(raw.city, 100).toLowerCase().trim(),
    district: sanitizeString(raw.district, 100).toLowerCase().trim(),
    address: sanitizeString(raw.address, 500),
    owner: OWNER_VALUES.has(raw.owner) ? raw.owner : "me",
    priority: PRIORITY_VALUES.has(raw.priority) ? raw.priority : "low",
    tags: sanitizeTags(raw.tags),
    notes: sanitizeString(raw.notes, 4000),
    coverUrl: sanitizeUrl(raw.coverUrl),
    reflection: sanitizeString(raw.reflection, 280),
    visitedAt: typeof raw.visitedAt === "string" ? raw.visitedAt : null,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
    order: typeof raw.order === "number" ? raw.order : fallbackOrder,
    x: typeof raw.x === "number" ? clampX(raw.x) : null,
    y: typeof raw.y === "number" ? clampY(raw.y) : null,
  };
}

function sanitizePlaces(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p, i) => sanitizePlace(p, i)).filter(Boolean);
}

// ─── places: CRUD ───
function makePlace(raw) {
  const parsed = parsePlace(raw);
  if (!parsed.name) return null;
  const pos = autoPositionFor(state.places.filter(p => p.country === parsed.country));
  return {
    id: newId(),
    name: parsed.name,
    country: parsed.country,
    city: parsed.city || "",
    district: parsed.district || "",
    address: "",
    owner: parsed.owner,
    priority: parsed.priority,
    tags: parsed.tags,
    notes: "",
    coverUrl: "",
    reflection: "",
    visitedAt: null,
    createdAt: new Date().toISOString(),
    order: state.places.length,
    x: pos.x,
    y: pos.y,
  };
}

async function addPlace(raw) {
  const place = makePlace(raw);
  if (!place) return;
  state.places.push(place);
  await savePlaces();
  render();
}

async function updatePlace(id, patch) {
  const place = state.places.find(p => p.id === id);
  if (!place) return;
  Object.assign(place, patch);
  await savePlaces();
}

async function deletePlace(id) {
  state.places = state.places.filter(p => p.id !== id);
  await savePlaces();
  render();
}

async function togglePlaceVisited(id) {
  const place = state.places.find(p => p.id === id);
  if (!place) return;
  const wasVisited = Boolean(place.visitedAt);
  place.visitedAt = wasVisited ? null : new Date().toISOString();
  if (!wasVisited) {
    state.placesExpanded.add(id);
    state.placesArchiveOpen = true;
    savePrefs();
  }
  await savePlaces();
  render();
  if (!wasVisited) focusPlaceReflection(id);
}

function focusPlaceReflection(id) {
  requestAnimationFrame(() => {
    const node = document.querySelector(`#places-archive-list .item[data-id="${id}"] .reflection, #places-list .item[data-id="${id}"] .reflection`);
    if (node) node.focus();
  });
}

// ─── places: filtering / sorting ───
function isPlaceVisible(place) {
  const f = state.placesFilter;
  if (f.kind === "all") return true;
  if (f.kind === "owner") return place.owner === f.value;
  if (f.kind === "tag") return place.tags.includes(f.value);
  return true;
}

function sortPlaces(places) {
  if (state.sort === "manual") return places.slice().sort((a, b) => a.order - b.order);
  if (state.sort === "added") return places.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  if (state.sort === "alpha") return places.slice().sort((a, b) => a.name.localeCompare(b.name));
  return places.slice().sort((a, b) =>
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.order - b.order
  );
}

function placesTagsAll() {
  const seen = new Set();
  state.places.forEach(p => p.tags.forEach(t => seen.add(t)));
  return [...seen].sort();
}

// ─── places: country index ───
function aggregateCountries() {
  const map = new Map();
  state.places.forEach(p => {
    if (!map.has(p.country)) map.set(p.country, { name: p.country, count: 0, visited: 0 });
    const e = map.get(p.country);
    e.count++;
    if (p.visitedAt) e.visited++;
  });
  const arr = [...map.values()];
  arr.sort((a, b) => {
    if (a.name === DEFAULT_COUNTRY) return -1;
    if (b.name === DEFAULT_COUNTRY) return 1;
    return b.count - a.count || a.name.localeCompare(b.name);
  });
  return arr;
}

function renderConstellation() {
  document.getElementById("constellation-wrap").hidden = false;
  document.getElementById("country-drill").hidden = true;
  const wrap = document.getElementById("country-index");
  const countries = aggregateCountries();
  wrap.replaceChildren();
  document.getElementById("places-empty").hidden = countries.length > 0;
  countries.forEach(c => wrap.appendChild(buildCountryRow(c)));
}

function buildCountryRow(country) {
  const li = document.createElement("li");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "country-row";
  const name = document.createElement("span");
  name.className = "country-name";
  name.textContent = country.name;
  const count = document.createElement("span");
  count.className = "country-count";
  count.textContent = String(country.count);
  if (country.visited > 0) {
    const v = document.createElement("span");
    v.className = "country-count-visited";
    v.textContent = `· ${country.visited} visited`;
    count.appendChild(v);
  }
  btn.appendChild(name);
  btn.appendChild(count);
  btn.addEventListener("click", () => drillIn(country.name));
  li.appendChild(btn);
  return li;
}

// ─── places: country drill ───
function renderCountryDrill() {
  document.getElementById("constellation-wrap").hidden = true;
  document.getElementById("country-drill").hidden = false;
  const country = state.drillCountry;
  ensurePlacePositionsForCountry(country);
  const all = state.places.filter(p => p.country === country);
  document.getElementById("country-title").textContent = `${country}.`;
  document.getElementById("country-meta").textContent =
    `${all.length} place${all.length === 1 ? "" : "s"} · ${all.filter(p => p.visitedAt).length} visited`;
  const visible = all.filter(isPlaceVisible);
  const active = visible.filter(p => !p.visitedAt);
  const archived = visible.filter(p => p.visitedAt);
  const canvas = document.getElementById("places-list");
  canvas.replaceChildren();
  active.forEach(p => canvas.appendChild(buildCardNode(p, "place")));
  growCanvas(canvas, active);
  document.getElementById("country-empty").hidden = active.length > 0 || archived.length > 0;
  renderPlacesDoneZone(archived);
  renderPlacesTagChips();
  syncPlacesActiveChip();
  state.placesLastRenderIds = new Set(state.places.map(p => p.id));
}

function renderPlacesDoneZone(archived) {
  const wrap = document.getElementById("places-archive");
  const listEl = document.getElementById("places-archive-list");
  listEl.replaceChildren();
  if (!archived.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  document.getElementById("places-archive-count").textContent = String(archived.length);
  const ordered = archived.slice().sort((a, b) =>
    (b.visitedAt ?? "").localeCompare(a.visitedAt ?? "")
  );
  ordered.forEach(p => listEl.appendChild(buildChipNode(p, "place")));
}

function renderGroupedPlaces(listEl, sorted) {
  const groups = { high: [], medium: [], low: [] };
  sorted.forEach(p => groups[p.priority].push(p));
  let n = 0;
  ["high", "medium", "low"].forEach(p => {
    if (!groups[p].length) return;
    listEl.appendChild(renderGroupHeader(PRIORITY_LABEL[p]));
    groups[p].forEach(place => { listEl.appendChild(buildPlaceNode(place, n)); n++; });
  });
}

function renderGroupedByCity(listEl, sorted) {
  const groups = new Map();
  sorted.forEach(p => {
    const k = p.city || "elsewhere";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  });
  const cityOrder = [...groups.keys()].sort((a, b) => {
    if (a === "elsewhere") return 1;
    if (b === "elsewhere") return -1;
    return groups.get(b).length - groups.get(a).length || a.localeCompare(b);
  });
  let n = 0;
  cityOrder.forEach(city => {
    listEl.appendChild(renderGroupHeader(`${city}.`));
    groups.get(city).forEach(p => { listEl.appendChild(buildPlaceNode(p, n)); n++; });
  });
}

function renderPlacesArchive(archived) {
  const wrap = document.getElementById("places-archive");
  const listEl = document.getElementById("places-archive-list");
  const toggle = document.getElementById("places-archive-toggle");
  listEl.replaceChildren();
  if (!archived.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  document.getElementById("places-archive-count").textContent = String(archived.length);
  toggle.setAttribute("aria-expanded", String(state.placesArchiveOpen));
  listEl.hidden = !state.placesArchiveOpen;
  const ordered = archived.slice().sort((a, b) =>
    (b.visitedAt ?? "").localeCompare(a.visitedAt ?? "")
  );
  ordered.forEach((p, i) => listEl.appendChild(buildPlaceNode(p, i)));
}

function renderPlacesTagChips() {
  const wrap = document.getElementById("places-tag-chips");
  wrap.replaceChildren();
  const country = state.drillCountry;
  const inCountry = country ? state.places.filter(p => p.country === country) : state.places;
  const tags = [...new Set(inCountry.flatMap(p => p.tags))].sort();
  tags.forEach(t => {
    const b = document.createElement("button");
    b.className = "chip";
    b.dataset.filter = "tag";
    b.dataset.value = t;
    b.textContent = `#${t}`;
    if (state.placesFilter.kind === "tag" && state.placesFilter.value === t) b.classList.add("is-active");
    wrap.appendChild(b);
  });
}

function syncPlacesActiveChip() {
  document.querySelectorAll("#places-filters .chip").forEach(chip => {
    const matches = state.placesFilter.kind === chip.dataset.filter &&
      (state.placesFilter.value ?? "all") === (chip.dataset.value ?? "all");
    chip.classList.toggle("is-active", matches);
  });
}

function renderPlacesStats() {
  const all = state.places;
  const visited = all.filter(p => p.visitedAt).length;
  const countries = new Set(all.map(p => p.country)).size;
  document.getElementById("count").textContent =
    `${all.length} place${all.length === 1 ? "" : "s"} across ${countries} ${countries === 1 ? "country" : "countries"}`;
  document.getElementById("percent").textContent = `${visited} visited`;
  const pct = all.length ? Math.round((visited / all.length) * 100) : 0;
  document.getElementById("bar-fill").style.width = `${pct}%`;
  const me = all.filter(p => p.owner === "me").length;
  const jv = all.filter(p => p.owner === "Jaevan").length;
  const us = all.filter(p => p.owner === "us").length;
  document.getElementById("substats").textContent = `me ${me} / Jaevan ${jv} / us ${us}`;
}

function renderPlacesView() {
  if (state.drillCountry) renderCountryDrill();
  else renderConstellation();
  renderPlacesStats();
}

// ─── places: node ───
function buildPlaceNode(place, index) {
  const tmpl = document.getElementById("place-template");
  const node = tmpl.content.firstElementChild.cloneNode(true);
  fillPlaceNode(node, place, index);
  if (!state.placesLastRenderIds.has(place.id)) node.classList.add("is-entering");
  if (!canEdit() || place.visitedAt) node.draggable = false;
  return node;
}

function fillPlaceNode(node, place, index) {
  node.dataset.id = place.id;
  node.dataset.priority = place.priority;
  node.dataset.owner = place.owner;
  node.classList.toggle("is-complete", Boolean(place.visitedAt));
  node.classList.toggle("is-expanded", state.placesExpanded.has(place.id));
  node.querySelector(".number").textContent = String(index + 1).padStart(2, "0");
  const titleEl = node.querySelector(".title");
  titleEl.textContent = place.name;
  titleEl.contentEditable = canEdit() ? "true" : "false";
  node.querySelector(".owner").textContent = place.owner;
  renderTagsInto(node.querySelector(".tag-list"), place.tags);
  node.querySelector(".marginalia").textContent = place.visitedAt ? formatDate(place.visitedAt) : "";
  fillPlaceAddress(node, place);
  fillPlaceDetail(node, place);
}

function fillPlaceAddress(node, place) {
  const row = node.querySelector(".address-row");
  const link = node.querySelector(".address-link");
  const text = node.querySelector(".address-text");
  const localised = [place.address, place.district, place.city, place.country].filter(Boolean).join(", ");
  const query = (place.address ? localised : `${place.name}, ${[place.district, place.city, place.country].filter(Boolean).join(", ")}`).trim();
  if (!query) { row.hidden = true; return; }
  row.hidden = false;
  link.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
  const display = place.address
    || [place.district, place.city].filter(Boolean).join(", ")
    || "find on maps";
  text.textContent = display;
}

function fillPlaceDetail(node, place) {
  const detail = node.querySelector(".detail");
  detail.hidden = !state.placesExpanded.has(place.id);
  const notes = node.querySelector(".notes");
  notes.value = place.notes ?? "";
  notes.readOnly = !canEdit();
  const cover = node.querySelector(".cover-url");
  cover.value = place.coverUrl ?? "";
  cover.readOnly = !canEdit();
  const addr = node.querySelector(".address-input");
  addr.value = place.address ?? "";
  addr.readOnly = !canEdit();
  const coverEl = node.querySelector(".cover");
  const safe = sanitizeUrl(place.coverUrl);
  if (safe) {
    coverEl.hidden = false;
    coverEl.style.backgroundImage = `url("${encodeURI(safe)}")`;
  } else { coverEl.hidden = true; coverEl.style.backgroundImage = ""; }
  fillPlaceReflection(node, place);
}

function fillPlaceReflection(node, place) {
  const r = node.querySelector(".reflection");
  const shown = node.querySelector(".reflection-shown");
  if (place.visitedAt) {
    r.hidden = Boolean(place.reflection);
    r.value = place.reflection ?? "";
    shown.hidden = !place.reflection;
    shown.textContent = place.reflection ? `"${place.reflection}"` : "";
  } else { r.hidden = true; shown.hidden = true; }
}

// ─── places: events ───
function handlePlacesClick(e) {
  if (e.target.closest(".address-link")) return;
  const tagBtn = e.target.closest(".tag");
  if (tagBtn?.dataset.tag) { filterPlaceByTag(tagBtn.dataset.tag); return; }
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.closest(".delete-x")) return softDeletePlace(id);
  if (e.target.closest(".check")) return handlePlaceVisit(id);
  if (e.target.closest(".expand")) return handlePlaceExpand(id);
  if (e.target.closest(".delete")) return softDeletePlace(id);
  if (e.target.closest(".priority-cycle")) return handlePlacePriorityCycle(id);
  if (e.target.closest(".owner-cycle")) return handlePlaceOwnerCycle(id);
  if (e.target.closest(".country-cycle")) return handlePlaceCountryCycle(id);
}

function handlePlaceVisit(id) { if (canEdit()) togglePlaceVisited(id); }

function handlePlaceExpand(id) {
  if (state.placesExpanded.has(id)) state.placesExpanded.delete(id);
  else state.placesExpanded.add(id);
  render();
}


async function handlePlacePriorityCycle(id) {
  if (!canEdit()) return;
  const place = state.places.find(p => p.id === id);
  if (!place) return;
  await updatePlace(id, { priority: cyclePriority(place.priority) });
  render();
}

async function handlePlaceOwnerCycle(id) {
  if (!canEdit()) return;
  const place = state.places.find(p => p.id === id);
  if (!place) return;
  await updatePlace(id, { owner: cycleOwner(place.owner) });
  render();
}

async function handlePlaceCountryCycle(id) {
  if (!canEdit()) return;
  const place = state.places.find(p => p.id === id);
  if (!place) return;
  const next = prompt("move to which country?", place.country);
  if (!next) return;
  const cleaned = sanitizeString(next, 80).toLowerCase().trim();
  if (!cleaned) return;
  await updatePlace(id, { country: cleaned });
  render();
}

function handlePlaceFilterClick(e) {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const kind = chip.dataset.filter;
  const value = chip.dataset.value;
  const same = state.placesFilter.kind === kind && (state.placesFilter.value ?? "all") === (value ?? "all");
  if (same && kind !== "all") state.placesFilter = { kind: "all", value: null };
  else state.placesFilter = { kind, value: kind === "all" ? null : value };
  savePrefs();
  render();
}

function filterPlaceByTag(tag) {
  state.placesFilter = { kind: "tag", value: tag };
  savePrefs();
  render();
}

function handlePlaceInlineBlur(e) {
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.classList.contains("title")) savePlaceName(id, e.target);
  if (e.target.classList.contains("cover-url")) handlePlaceCoverUrlBlur(id, e.target);
  if (e.target.classList.contains("reflection")) handlePlaceReflectionBlur(id, e.target);
  if (e.target.classList.contains("address-input")) handlePlaceAddressBlur(id, e.target);
}

function handlePlaceInlineInput(e) {
  if (!canEdit()) return;
  const item = e.target.closest(".item");
  if (!item) return;
  const id = item.dataset.id;
  if (e.target.classList.contains("notes")) updatePlace(id, { notes: sanitizeString(e.target.value, 4000) });
  if (e.target.classList.contains("title")) {
    const next = sanitizeString(e.target.textContent, 280).replace(/\s+/g, " ").trim();
    if (next) updatePlace(id, { name: next });
  }
}

function savePlaceName(id, el) {
  if (!canEdit()) return;
  const next = sanitizeString(el.textContent, 280).replace(/\s+/g, " ").trim();
  if (!next) { deletePlace(id); return; }
  updatePlace(id, { name: next });
}

function handlePlaceCoverUrlBlur(id, el) {
  if (!canEdit()) return;
  updatePlace(id, { coverUrl: sanitizeUrl(el.value) });
  render();
}

function handlePlaceReflectionBlur(id, el) {
  if (!canEdit()) return;
  updatePlace(id, { reflection: el.value.trim() });
  const node = document.querySelector(`.item[data-id="${id}"]`);
  const place = state.places.find(p => p.id === id);
  if (node && place) fillPlaceReflection(node, place);
}

function handlePlaceAddressBlur(id, el) {
  if (!canEdit()) return;
  updatePlace(id, { address: el.value.trim() });
  const node = document.querySelector(`.item[data-id="${id}"]`);
  const place = state.places.find(p => p.id === id);
  if (node && place) { fillPlaceAddress(node, place); fillPlaceDetail(node, place); }
}

// ─── location autocomplete ───
async function loadLocations() {
  try {
    const r = await fetch("assets/locations.json", { cache: "force-cache" });
    if (!r.ok) return;
    const data = await r.json();
    if (Array.isArray(data?.countries) && data.cities) state.locations = data;
  } catch {}
}

function partialAtToken(input, cursor) {
  const before = input.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const head = before.slice(at + 1);
  if (/\s/.test(head)) return null;
  const after = input.slice(cursor);
  const tail = (after.match(/^[^\s]*/) || [""])[0];
  return { at, full: head + tail, end: cursor + tail.length };
}

function suggestForToken(partial) {
  const locs = state.locations || { countries: [], cities: {} };
  const parts = partial.toLowerCase().split(".");
  if (parts.length === 1) {
    const pref = parts[0].replace(/-/g, " ");
    const pool = locs.countries || [];
    return (pref ? pool.filter(c => c.startsWith(pref)) : pool).slice(0, 7);
  }
  if (parts.length === 2) {
    const country = parts[0].replace(/-/g, " ");
    const pref = parts[1].replace(/-/g, " ");
    const cities = locs.cities?.[country] || [];
    const matched = pref ? cities.filter(c => c.startsWith(pref)) : cities;
    return matched.slice(0, 7).map(c => `${country}.${c}`);
  }
  return [];
}

function renderSuggestStrip() {
  const wrap = document.getElementById("composer-suggest");
  const input = document.getElementById("add-input");
  const cursor = input.selectionStart ?? input.value.length;
  if (state.view !== "places") { hideSuggestStrip(); return; }
  const partial = partialAtToken(input.value, cursor);
  if (!partial) { hideSuggestStrip(); return; }
  const matches = suggestForToken(partial.full);
  if (!matches.length) { hideSuggestStrip(); return; }
  wrap.replaceChildren();
  matches.forEach(m => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "suggest-chip";
    chip.textContent = m;
    chip.tabIndex = 0;
    const fire = () => insertSuggestion(input, partial, m);
    chip.addEventListener("mousedown", e => { e.preventDefault(); fire(); });
    chip.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fire(); }
      else if (e.key === "Escape") { e.preventDefault(); hideSuggestStrip(); input.focus(); }
      else if (e.key === "ArrowRight") {
        e.preventDefault();
        (chip.nextElementSibling || wrap.firstElementChild)?.focus();
      }
      else if (e.key === "ArrowLeft") {
        e.preventDefault();
        (chip.previousElementSibling || wrap.lastElementChild)?.focus();
      }
    });
    wrap.appendChild(chip);
  });
  wrap.hidden = false;
}

function hideSuggestStrip() {
  const wrap = document.getElementById("composer-suggest");
  wrap.hidden = true;
  wrap.replaceChildren();
}

function insertSuggestion(input, partial, suggestion) {
  const dashed = suggestion.replace(/\s+/g, "-");
  const before = input.value.slice(0, partial.at);
  const after = input.value.slice(partial.end);
  const inserted = "@" + dashed;
  input.value = before + inserted + after;
  const cursor = (before + inserted).length;
  input.focus();
  input.setSelectionRange(cursor, cursor);
  renderSuggestStrip();
  document.getElementById("composer-hint").hidden = true;
  handleAddInput({ target: input });
}

// ─── view router ───
function loadView() {
  const saved = localStorage.getItem(VIEW_KEY);
  if (saved === "list" || saved === "places") state.view = saved;
}

function saveView() { localStorage.setItem(VIEW_KEY, state.view); }

function switchView(view) {
  if (state.view === view) return;
  state.view = view;
  saveView();
  applyViewToUi();
  render();
}

function applyViewToUi() {
  document.getElementById("view-list").hidden = state.view !== "list";
  document.getElementById("view-places").hidden = state.view !== "places";
  document.querySelectorAll(".view-tab").forEach(t => {
    t.classList.toggle("is-active", t.dataset.view === state.view);
  });
  updateComposerPlaceholder();
  syncSortLabel();
  hideSuggestStrip();
}

function updateComposerPlaceholder() {
  const input = document.getElementById("add-input");
  if (state.view === "places") {
    if (state.drillCountry) input.placeholder = `a spot in ${state.drillCountry}…  try  #cafe`;
    else input.placeholder = "somewhere you'd like to go…  try  @japan  #cafe";
  } else {
    input.placeholder = "something you'd like to do…  try  #me  #jaevan  !high";
  }
}

function drillIn(country) {
  state.drillCountry = country;
  state.placesFilter = { kind: "all", value: null };
  updateComposerPlaceholder();
  render();
}

function drillOut() {
  state.drillCountry = null;
  updateComposerPlaceholder();
  render();
}

// ─── archive toggles ───
function toggleArchive() {
  state.archiveOpen = !state.archiveOpen;
  savePrefs();
  render();
}

function togglePlacesArchive() {
  state.placesArchiveOpen = !state.placesArchiveOpen;
  savePrefs();
  render();
}

// ─── suggestion adapted for places ───
function pickPlaceSuggestion() {
  const pool = state.places.filter(p => !p.visitedAt);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showSuggestionForView() {
  if (state.view === "places") {
    const place = pickPlaceSuggestion();
    const box = document.getElementById("suggestion");
    if (!place) { box.hidden = true; return; }
    box.hidden = false;
    box.querySelector(".suggestion-label").textContent = "for today, consider going to —";
    box.querySelector(".suggestion-item").textContent = `${place.name}, ${place.country}`;
  } else {
    document.getElementById("suggestion").querySelector(".suggestion-label").textContent = "for today, consider —";
    showSuggestion();
  }
}

// ─── wiring ───
function bindEvents() {
  document.getElementById("add-form").addEventListener("submit", handleAddSubmit);
  document.getElementById("add-input").addEventListener("input", handleAddInput);
  document.getElementById("add-input").addEventListener("keydown", handleComposerKeydown);
  document.getElementById("filters").addEventListener("click", handleFilterClick);
  document.getElementById("places-filters").addEventListener("click", handlePlaceFilterClick);
  bindList();
  document.getElementById("today-link").addEventListener("click", showSuggestionForView);
  document.getElementById("sort-link").addEventListener("click", tidyLayout);
  document.getElementById("export-link").addEventListener("click", downloadJson);
  document.getElementById("import-link").addEventListener("click", () => document.getElementById("import-file").click());
  document.getElementById("import-file").addEventListener("change", handleImportFile);
  document.getElementById("gate-link").addEventListener("click", handleGateLink);
  document.getElementById("gate-form").addEventListener("submit", handleGateSubmit);
  document.getElementById("gate-cancel").addEventListener("click", handleGateCancel);
  document.getElementById("view-tabs").addEventListener("click", e => {
    const tab = e.target.closest(".view-tab");
    if (tab) switchView(tab.dataset.view);
  });
  document.getElementById("drill-back").addEventListener("click", drillOut);
  document.addEventListener("keydown", handleGlobalKeydown);
  window.addEventListener("beforeunload", () => { flushPendingSave(); flushPendingSavePlaces(); });
}

// ─── canvas: pointer drag + click ───
let dragState = null;

function handleCardPointerDown(e) {
  if (!canEdit()) return;
  if (e.target.closest(".delete-x, button, input, textarea, a, .tag")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  // If the title is already focused (user is editing) — don't hijack
  const titleEl = card.querySelector(".title");
  if (titleEl && document.activeElement === titleEl) return;
  const rect = card.getBoundingClientRect();
  const canvas = card.parentElement;
  const canvasRect = canvas.getBoundingClientRect();
  dragState = {
    id: card.dataset.id, kind: card.dataset.kind, card, canvas,
    offsetX: e.clientX - rect.left,
    offsetY: e.clientY - rect.top,
    canvasLeft: canvasRect.left,
    canvasTop: canvasRect.top,
    moved: false,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
  };
  document.addEventListener("pointermove", handleCardPointerMove);
  document.addEventListener("pointerup", handleCardPointerUp);
  document.addEventListener("pointercancel", handleCardPointerUp);
}

function handleCardPointerMove(e) {
  if (!dragState) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (!dragState.moved && Math.hypot(dx, dy) < 6) return;
  if (!dragState.moved) {
    dragState.moved = true;
    dragState.card.classList.add("is-dragging");
    try { dragState.card.setPointerCapture(dragState.pointerId); } catch {}
    window.getSelection()?.removeAllRanges();
    e.preventDefault();
  }
  const x = e.clientX - dragState.canvasLeft - dragState.offsetX;
  const y = e.clientY - dragState.canvasTop - dragState.offsetY;
  dragState.card.style.left = x + "px";
  dragState.card.style.top = y + "px";
  highlightDoneZoneIfOver(e, dragState.kind);
}

function highlightDoneZoneIfOver(e, kind) {
  const doneZoneId = kind === "place" ? "places-archive" : "archive";
  const doneZone = document.getElementById(doneZoneId);
  if (!doneZone || doneZone.hidden) return;
  const dz = doneZone.getBoundingClientRect();
  const over = e.clientX >= dz.left && e.clientX <= dz.right &&
               e.clientY >= dz.top && e.clientY <= dz.bottom;
  doneZone.classList.toggle("is-target", over);
}

async function handleCardPointerUp(e) {
  if (!dragState) return;
  const ds = dragState;
  dragState = null;
  document.removeEventListener("pointermove", handleCardPointerMove);
  document.removeEventListener("pointerup", handleCardPointerUp);
  document.removeEventListener("pointercancel", handleCardPointerUp);
  ds.card.classList.remove("is-dragging");
  document.querySelectorAll(".done-zone.is-target").forEach(el => el.classList.remove("is-target"));
  if (!ds.moved) return;
  if (await maybeDropOnDoneZone(e, ds)) return;
  const x = clampX(e.clientX - ds.canvasLeft - ds.offsetX);
  const y = clampY(e.clientY - ds.canvasTop - ds.offsetY);
  if (ds.kind === "place") {
    await updatePlace(ds.id, { x, y });
  } else {
    await updateItem(ds.id, { x, y });
  }
  growCanvas(ds.canvas, ds.kind === "place" ? state.places.filter(p => p.country === state.drillCountry && !p.visitedAt) : state.items.filter(i => !i.completedAt));
}

async function maybeDropOnDoneZone(e, ds) {
  const doneZoneId = ds.kind === "place" ? "places-archive" : "archive";
  const doneZone = document.getElementById(doneZoneId);
  let inZone = false;
  if (doneZone && !doneZone.hidden) {
    const dz = doneZone.getBoundingClientRect();
    inZone = e.clientX >= dz.left && e.clientX <= dz.right &&
             e.clientY >= dz.top - 20 && e.clientY <= dz.bottom + 200;
  }
  const canvasBottom = ds.canvasTop + ds.canvas.offsetHeight;
  const pastCanvas = e.clientY > canvasBottom - 10;
  if (!inZone && !pastCanvas) return false;
  if (ds.kind === "place") await togglePlaceVisited(ds.id);
  else await toggleComplete(ds.id);
  return true;
}

function handleCardClick(e) {
  if (e.target.closest(".address-link")) return;
  const tagBtn = e.target.closest(".tag");
  if (tagBtn?.dataset.tag) {
    const card = e.target.closest(".card");
    const kind = card?.dataset?.kind;
    if (kind === "place") filterPlaceByTag(tagBtn.dataset.tag);
    else filterByTag(tagBtn.dataset.tag);
    return;
  }
  if (!e.target.closest(".delete-x")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  if (card.dataset.kind === "place") softDeletePlace(card.dataset.id);
  else softDeleteItem(card.dataset.id);
}

function handleCardBlur(e) {
  if (!e.target.classList.contains("title")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  if (card.dataset.kind === "place") savePlaceName(card.dataset.id, e.target);
  else saveTitle(card.dataset.id, e.target);
}

function handleCardInput(e) {
  if (!canEdit()) return;
  if (!e.target.classList.contains("title")) return;
  const card = e.target.closest(".card");
  if (!card) return;
  const next = sanitizeString(e.target.textContent, 280).replace(/\s+/g, " ").trim();
  if (!next) return;
  if (card.dataset.kind === "place") updatePlace(card.dataset.id, { name: next });
  else updateItem(card.dataset.id, { title: next });
}

async function handleChipClick(e) {
  if (!canEdit()) return;
  const chip = e.target.closest(".done-chip");
  if (!chip) return;
  if (chip.dataset.kind === "place") await togglePlaceVisited(chip.dataset.id);
  else await toggleComplete(chip.dataset.id);
}

// ─── wiring ───
function bindList() {
  ["list", "places-list"].forEach(id => bindCanvas(id));
  ["archive-list", "places-archive-list"].forEach(id => bindDoneList(id));
}

function bindCanvas(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("pointerdown", handleCardPointerDown);
  el.addEventListener("click", handleCardClick);
  el.addEventListener("blur", handleCardBlur, true);
  el.addEventListener("input", handleCardInput, true);
  el.addEventListener("keydown", handleInlineKeydown, true);
  el.addEventListener("paste", handlePaste, true);
}

function bindDoneList(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", handleChipClick);
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

function handleComposerKeydown(e) {
  const wrap = document.getElementById("composer-suggest");
  if (e.key === "Tab" && !e.shiftKey && !wrap.hidden) {
    const firstChip = wrap.querySelector(".suggest-chip");
    if (firstChip) { e.preventDefault(); firstChip.focus(); }
  } else if (e.key === "Escape") {
    if (!wrap.hidden) { e.preventDefault(); hideSuggestStrip(); }
  }
}

// ─── boot ───
async function boot() {
  loadPrefs();
  loadView();
  state.supabase = await setupSupabase();
  await syncEditModeFromSession();
  applyEditModeUi();
  applyViewToUi();
  loadEpigraph();
  bindEpigraph();
  bindEvents();
  loadLocations();
  await Promise.all([loadItems(), loadPlaces()]);
  render();
  subscribeRemoteChanges();
}

boot();
