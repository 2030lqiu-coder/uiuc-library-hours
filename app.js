// UIUC Library Hours — live data from the University Library directory API.
// The API sends no CORS headers but supports JSONP, so this runs as a plain static site.

const API_URL = "https://libdirectory.library.illinois.edu/Api/UnitsInGateway";
const TZ = "America/Chicago";
const REFRESH_MS = 10 * 60 * 1000;
const CAMPUS_CENTER = [40.1055, -88.2272];

// Fixes for API locations that are missing or point at the wrong building (keyed by unit_id).
const COORD_OVERRIDES = {
  38: [40.104726, -88.228919],  // Central Access Services — inside the Main Library
  81: [40.098047, -88.214412],  // Archives Research Center — 1707 S Orchard St
};

// Favorites live in this browser only; storage can be unavailable (private mode).
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  },
};

const state = {
  libraries: [],
  query: "",
  openOnly: false,
  sort: "status",
  view: "cards",
  expanded: new Set(),
  favorites: new Set(store.get("favorites", [])),
  fetchedAt: null,
};

function toggleFavorite(id) {
  state.favorites.has(id) ? state.favorites.delete(id) : state.favorites.add(id);
  store.set("favorites", [...state.favorites]);
  render();
}

function parseCoords(unit) {
  if (COORD_OVERRIDES[unit.unit_id]) return COORD_OVERRIDES[unit.unit_id];
  const m = /[?&]ll=(-?[\d.]+),(-?[\d.]+)/.exec(unit.map_url || "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// ---------- Data loading ----------

function jsonp(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const cb = `__libhours_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const script = document.createElement("script");
    const timer = setTimeout(() => cleanup(new Error("Request timed out")), timeoutMs);

    function cleanup(err, data) {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
      err ? reject(err) : resolve(data);
    }

    window[cb] = (data) => cleanup(null, data);
    script.onerror = () => cleanup(new Error("Could not reach the library API"));
    script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${cb}`;
    document.head.appendChild(script);
  });
}

function normalize(unit) {
  const cal = unit.calendar;
  const days = cal.nextSevenDays.map((d) => ({
    date: d.date,
    day: d.day,
    hours: d.hours.map((h) => ({ label: h.label, start: h.startTime, end: h.endTime })),
  }));

  // The API marks days on or after `no_hours_date` as unpublished; mirror the official site.
  if (cal.no_hours_date) {
    const cutoff = cal.no_hours_date.slice(0, 10);
    for (const d of days) {
      if (toIsoDate(d.date) >= cutoff) d.hours = [{ label: "To Be Announced", start: null, end: null }];
    }
  }

  return {
    id: unit.unit_id,
    name: unit.unit_name,
    building: unit.building_name,
    address: [unit.street_address, unit.city].filter(Boolean).join(", "),
    phone: unit.phone_number,
    email: unit.contact_email,
    website: unit.weblinks,
    mapUrl: unit.campus_map_url || unit.directions,
    studyRooms: unit.study_rooms,
    directions: unit.directions,
    coords: parseCoords(unit),
    note: unit.calendar_note,
    days,
    intervals: mergeIntervals(days.flatMap((d) => d.hours.filter((h) => h.start && h.end))),
  };
}

async function load() {
  setStatus("Loading live hours…");
  try {
    const units = await jsonp(API_URL);
    state.libraries = units.filter((u) => u.calendar && u.calendar.success).map(normalize);
    state.fetchedAt = new Date();
    setStatus("");
    render();
  } catch (err) {
    setStatus(`${err.message}. Retrying shortly — or check the official hours page.`, true);
    setTimeout(load, 30000);
  }
}

// ---------- Time helpers (all comparisons in campus local time) ----------

// "MM/DD/YYYY" -> "YYYY-MM-DD"
function toIsoDate(mdy) {
  const [m, d, y] = mdy.split("/");
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

// Current campus wall-clock time as "YYYY-MM-DDTHH:MM:SS", directly comparable with API timestamps.
function campusNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}

// Merge back-to-back intervals so a 24-hour stretch reads as one long opening.
function mergeIntervals(hours) {
  const sorted = hours.map((h) => ({ start: h.start, end: h.end })).sort((a, b) => a.start.localeCompare(b.start));
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      out.push({ ...iv });
    }
  }
  return out;
}

function minutesBetween(a, b) {
  return (Date.parse(b + "Z") - Date.parse(a + "Z")) / 60000;
}

function fmtTime(ts) {
  const [h, m] = ts.slice(11, 16).split(":").map(Number);
  if (h === 0 && m === 0) return "midnight";
  if (h === 12 && m === 0) return "noon";
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, "0")} ${suffix}` : `${h12} ${suffix}`;
}

// For closing times, anything before 6 AM belongs to the previous evening ("closes 2 AM", not "2 AM tomorrow").
function fmtDayRelative(ts, now, isClosing = false) {
  const shift = (t) => (isClosing ? new Date(Date.parse(t + "Z") - 6 * 3600000).toISOString() : t);
  const day = shift(ts).slice(0, 10);
  const today = shift(now).slice(0, 10);
  const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  if (day === today) return "";
  if (day === tomorrow) return " tomorrow";
  const weekday = new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return ` ${weekday}`;
}

function fmtDuration(mins) {
  if (mins < 60) return `${Math.max(1, Math.round(mins))} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// Prettier label for a single opening, e.g. "8:30 AM – 2 AM".
function fmtRange(h) {
  if (!h.start || !h.end) return h.label;
  if (h.label === "Open 24 Hours") return "Open 24 hours";
  return `${fmtTime(h.start)} – ${fmtTime(h.end)}`;
}

function getStatus(lib, now) {
  const current = lib.intervals.find((iv) => iv.start <= now && now < iv.end);
  if (current) {
    const left = minutesBetween(now, current.end);
    if (left >= 7 * 24 * 60 - 60) return { open: true, kind: "open", text: "Open 24 hours", sortKey: 0 };
    const closingSoon = left <= 60;
    return {
      open: true,
      kind: closingSoon ? "closing" : "open",
      text: closingSoon
        ? `Closes in ${fmtDuration(left)}`
        : `Open · closes ${fmtTime(current.end)}${fmtDayRelative(current.end, now, true)}`,
      sortKey: 1,
      minutes: left,
    };
  }
  const next = lib.intervals.find((iv) => iv.start > now);
  if (next) {
    const until = minutesBetween(now, next.start);
    return {
      open: false,
      kind: until <= 60 ? "opening" : "closed",
      text: until <= 60
        ? `Opens in ${fmtDuration(until)}`
        : `Closed · opens ${fmtTime(next.start)}${fmtDayRelative(next.start, now)}`,
      sortKey: 2,
      minutes: until,
    };
  }
  return { open: false, kind: "closed", text: "Closed · no hours posted this week", sortKey: 3, minutes: Infinity };
}

// ---------- Rendering ----------

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function stripHtml(s) {
  const div = document.createElement("div");
  div.innerHTML = String(s ?? "").replace(/<br\s*\/?>/gi, "\n");
  return div.textContent.trim();
}

function setStatus(msg, isError = false) {
  const el = $("#status");
  el.textContent = msg;
  el.hidden = !msg;
  el.classList.toggle("error", isError);
}

function visibleLibraries(now) {
  const q = state.query.trim().toLowerCase();
  let list = state.libraries.map((lib) => ({ lib, status: getStatus(lib, now) }));
  if (q) list = list.filter(({ lib }) => `${lib.name} ${lib.building} ${lib.address}`.toLowerCase().includes(q));
  if (state.openOnly) list = list.filter(({ status }) => status.open);

  const byName = (a, b) => a.lib.name.localeCompare(b.lib.name);
  if (state.sort === "name") list.sort(byName);
  else list.sort((a, b) => a.status.sortKey - b.status.sortKey || (a.status.minutes ?? 0) - (b.status.minutes ?? 0) || byName(a, b));
  if (state.sort === "status") {
    // Among open libraries, show the ones open latest first — more useful than "closing soonest".
    const open = list.filter((x) => x.status.open).sort((a, b) => (b.status.minutes ?? Infinity) - (a.status.minutes ?? Infinity) || byName(a, b));
    list = [...open, ...list.filter((x) => !x.status.open)];
  }
  return list;
}

function render() {
  if (!state.libraries.length) return;
  const now = campusNow();
  const list = visibleLibraries(now);
  const openCount = state.libraries.filter((lib) => getStatus(lib, now).open).length;

  $("#summary").innerHTML =
    `<strong>${openCount}</strong> of ${state.libraries.length} libraries open right now`;
  $("#clock").textContent = new Date().toLocaleString("en-US", {
    timeZone: TZ, weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  }) + " · Central Time";
  $("#updated").textContent = state.fetchedAt
    ? `Data refreshed ${state.fetchedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "";

  document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === state.view));
  $("#cards").hidden = state.view !== "cards";
  $("#week").hidden = state.view !== "week";
  $("#map-view").hidden = state.view !== "map";

  // Favorites float to the top of every view.
  const favs = list.filter(({ lib }) => state.favorites.has(lib.id));
  const rest = list.filter(({ lib }) => !state.favorites.has(lib.id));

  const empty = !list.length;
  $("#empty").hidden = !empty;
  if (state.view === "cards") $("#cards").innerHTML = cardsHtml(favs, rest, now);
  else if (state.view === "week") $("#week").innerHTML = empty ? "" : weekHtml([...favs, ...rest].map((x) => x.lib), now);
  else renderMap(list, now);
}

function hoursForDay(day) {
  return day.hours.map(fmtRange).join(", ");
}

function todayOf(lib, now) {
  return lib.days.find((d) => toIsoDate(d.date) === now.slice(0, 10)) || lib.days[0];
}

function favButton(lib) {
  const on = state.favorites.has(lib.id);
  return `<button class="fav${on ? " on" : ""}" data-fav="${lib.id}" aria-pressed="${on}"
    aria-label="${on ? "Remove" : "Add"} ${escapeHtml(lib.name)} ${on ? "from" : "to"} favorites"
    title="${on ? "Remove from" : "Add to"} favorites">${on ? "★" : "☆"}</button>`;
}

function cardsHtml(favs, rest, now) {
  const grid = (items) => `<div class="cards">${items.map(({ lib, status }) => cardHtml(lib, status, now)).join("")}</div>`;
  let html = "";
  if (favs.length) {
    html += `<h2 class="section-title"><span class="star">★</span> Your favorites</h2>${grid(favs)}`;
  }
  if (rest.length) {
    html += favs.length || state.favorites.size
      ? `<h2 class="section-title">All libraries</h2>`
      : `<p class="hint">Tap ☆ on any library to pin it to the top.</p>`;
    html += grid(rest);
  }
  return html;
}

function cardHtml(lib, status, now) {
  const expanded = state.expanded.has(lib.id);
  const note = stripHtml(lib.note);
  const links = [
    lib.coords && `<button class="link-btn" data-show-map="${lib.id}">Show on map</button>`,
    lib.website && `<a href="${escapeHtml(lib.website)}" target="_blank" rel="noopener">Website</a>`,
    lib.directions && `<a href="${escapeHtml(lib.directions)}" target="_blank" rel="noopener">Directions</a>`,
    lib.studyRooms && `<a href="${escapeHtml(lib.studyRooms)}" target="_blank" rel="noopener">Study rooms</a>`,
    lib.phone && `<a href="tel:${escapeHtml(lib.phone)}">${escapeHtml(lib.phone)}</a>`,
  ].filter(Boolean).join("");

  return `
    <article class="card ${status.kind}">
      <header>
        <div class="title-row">
          <h3>${escapeHtml(lib.name)}</h3>
          ${favButton(lib)}
        </div>
        <span class="pill ${status.kind}"><span class="dot"></span>${escapeHtml(status.text)}</span>
      </header>
      <p class="today"><span>Today</span> ${escapeHtml(hoursForDay(todayOf(lib, now)))}</p>
      <p class="address">${escapeHtml(lib.address)}</p>
      <button class="toggle" data-id="${lib.id}" aria-expanded="${expanded}">
        ${expanded ? "Hide" : "Show"} this week
      </button>
      ${expanded ? `
        <table class="days">
          ${lib.days.map((d) => `
            <tr class="${toIsoDate(d.date) === now.slice(0, 10) ? "is-today" : ""}">
              <th>${escapeHtml(d.day === "Today" ? "Today" : d.day.slice(0, 3))} <span>${escapeHtml(d.date.slice(0, 5))}</span></th>
              <td>${escapeHtml(hoursForDay(d))}</td>
            </tr>`).join("")}
        </table>
        ${note ? `<p class="note">${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}
        <nav class="links">${links}</nav>` : ""}
    </article>`;
}

function weekHtml(libs, now) {
  const days = libs[0].days;
  const head = days.map((d) => {
    const isToday = toIsoDate(d.date) === now.slice(0, 10);
    return `<th class="${isToday ? "is-today" : ""}">${escapeHtml(isToday ? "Today" : d.day.slice(0, 3))}<span>${escapeHtml(d.date.slice(0, 5))}</span></th>`;
  }).join("");
  const rows = libs.map((lib) => {
    const status = getStatus(lib, now);
    const cells = days.map((d) => {
      const match = lib.days.find((x) => x.date === d.date);
      const text = match ? hoursForDay(match) : "—";
      const isToday = toIsoDate(d.date) === now.slice(0, 10);
      return `<td class="${isToday ? "is-today" : ""} ${/closed/i.test(text) ? "muted" : ""}">${escapeHtml(text)}</td>`;
    }).join("");
    const fav = state.favorites.has(lib.id) ? " is-fav" : "";
    return `<tr class="${fav}"><th scope="row"><div class="row-head">${favButton(lib)}<span class="dot ${status.kind}" title="${escapeHtml(status.text)}"></span><span>${escapeHtml(lib.name)}</span></div></th>${cells}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Library</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- Map ----------

const KIND_RANK = { open: 0, closing: 1, opening: 2, closed: 3 };
const mapState = { map: null, layer: null, markers: new Map(), signature: "", fitted: false };

// Several libraries share a building (eight are in the Main Library), so group nearby ones into one pin.
function groupByLocation(items) {
  const groups = [];
  for (const item of items) {
    const [lat, lng] = item.lib.coords;
    const near = groups.find((g) => Math.hypot((g.lat - lat) * 111000, (g.lng - lng) * 85000) < 60);
    if (near) near.items.push(item);
    else groups.push({ lat, lng, items: [item] });
  }
  for (const g of groups) g.key = g.items.map((x) => x.lib.id).sort((a, b) => a - b).join("-");
  return groups;
}

function ensureMap() {
  if (mapState.map) return true;
  if (!window.L) {
    $("#map").innerHTML = `<p class="map-error">The map couldn't load. Check your connection and refresh.</p>`;
    return false;
  }
  mapState.map = L.map("map", { zoomControl: true }).setView(CAMPUS_CENTER, 15);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(mapState.map);
  mapState.layer = L.layerGroup().addTo(mapState.map);
  return true;
}

function pinIcon(group) {
  const kind = group.items.reduce((best, x) => (KIND_RANK[x.status.kind] < KIND_RANK[best] ? x.status.kind : best), "closed");
  const hasFav = group.items.some((x) => state.favorites.has(x.lib.id));
  const count = group.items.length;
  return L.divIcon({
    className: "",
    html: `<div class="pin ${kind}${hasFav ? " fav" : ""}">${count > 1 ? count : ""}${hasFav ? `<span class="pin-star">★</span>` : ""}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -14],
  });
}

function popupHtml(group, now) {
  const items = [...group.items].sort((a, b) =>
    (state.favorites.has(b.lib.id) - state.favorites.has(a.lib.id)) || KIND_RANK[a.status.kind] - KIND_RANK[b.status.kind] || a.lib.name.localeCompare(b.lib.name));
  const first = group.items[0].lib;
  const building = group.items.length > 1 ? first.building || first.address : "";
  return `
    <div class="popup">
      ${building ? `<p class="popup-building">${escapeHtml(building)}</p>` : ""}
      ${items.map(({ lib, status }) => `
        <div class="popup-lib">
          <div class="title-row"><strong>${escapeHtml(lib.name)}</strong>${favButton(lib)}</div>
          <span class="pill ${status.kind}"><span class="dot"></span>${escapeHtml(status.text)}</span>
          <p class="popup-today">Today: ${escapeHtml(hoursForDay(todayOf(lib, now)))}</p>
        </div>`).join("")}
      <p class="popup-links">
        <span>${escapeHtml(first.address)}</span>
        ${first.directions ? `<a href="${escapeHtml(first.directions)}" target="_blank" rel="noopener">Directions ↗</a>` : ""}
      </p>
    </div>`;
}

function renderMap(list, now) {
  if (!ensureMap()) return;
  // Leaflet measures its container; it was hidden until now.
  setTimeout(() => mapState.map.invalidateSize());

  const groups = groupByLocation(list.filter((x) => x.lib.coords));
  const signature = groups.map((g) => g.key).join("|");

  if (signature === mapState.signature) {
    // Same pins: refresh in place so an open popup stays open.
    for (const g of groups) {
      const marker = mapState.markers.get(g.key);
      marker.setIcon(pinIcon(g));
      marker.setPopupContent(popupHtml(g, now));
    }
    return;
  }

  mapState.signature = signature;
  mapState.layer.clearLayers();
  mapState.markers.clear();
  for (const g of groups) {
    const marker = L.marker([g.lat, g.lng], { icon: pinIcon(g), title: g.items.map((x) => x.lib.name).join(", ") })
      .bindPopup(popupHtml(g, now), { maxWidth: 300, minWidth: 220, maxHeight: 340, autoPanPadding: [20, 20] });
    marker.libIds = g.items.map((x) => x.lib.id);
    mapState.layer.addLayer(marker);
    mapState.markers.set(g.key, marker);
  }
  if (!mapState.fitted && groups.length) {
    mapState.fitted = true;
    setTimeout(() => mapState.map.fitBounds(L.latLngBounds(groups.map((g) => [g.lat, g.lng])), { padding: [30, 30] }));
  }
}

function setView(view) {
  state.view = view;
  render();
}

function showOnMap(id) {
  // Clear filters that could hide this library's pin.
  state.query = "";
  state.openOnly = false;
  $("#search").value = "";
  $("#open-only").checked = false;
  setView("map");
  const marker = [...mapState.markers.values()].find((m) => m.libIds.includes(id));
  if (!marker) return;
  window.scrollTo({ top: $("#map-view").offsetTop - 16, behavior: "smooth" });
  setTimeout(() => {
    mapState.map.setView(marker.getLatLng(), 17);
    marker.openPopup();
  });
}

// ---------- Wiring ----------

function bind() {
  $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
  $("#open-only").addEventListener("change", (e) => { state.openOnly = e.target.checked; render(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => setView(btn.dataset.view))
  );
  // One delegated handler covers cards, the week table, and map popups. It listens in the capture
  // phase because Leaflet stops clicks inside popups from bubbling.
  document.addEventListener("click", (e) => {
    const fav = e.target.closest("[data-fav]");
    if (fav) {
      // Re-rendering swaps out the clicked button; stop here so Leaflet doesn't read it as a map click and close the popup.
      e.stopPropagation();
      return toggleFavorite(Number(fav.dataset.fav));
    }
    const mapBtn = e.target.closest("[data-show-map]");
    if (mapBtn) return showOnMap(Number(mapBtn.dataset.showMap));
    const toggle = e.target.closest(".toggle");
    if (toggle) {
      const id = Number(toggle.dataset.id);
      state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
      render();
    }
  }, true);
}

bind();
load();
setInterval(render, 30 * 1000);   // keep open/closed status current
setInterval(load, REFRESH_MS);    // pick up schedule changes
