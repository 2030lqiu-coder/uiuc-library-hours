// UIUC Library Hours — live data from the University Library directory API.
// The API sends no CORS headers but supports JSONP, so this runs as a plain static site.

const API_URL = "https://libdirectory.library.illinois.edu/Api/UnitsInGateway";
const TZ = "America/Chicago";
const REFRESH_MS = 10 * 60 * 1000;

const state = {
  libraries: [],
  query: "",
  openOnly: false,
  sort: "status",
  view: "cards",
  expanded: new Set(),
  fetchedAt: null,
};

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

  $("#cards").hidden = state.view !== "cards";
  $("#week").hidden = state.view !== "week";

  const empty = !list.length;
  $("#empty").hidden = !empty;
  if (state.view === "cards") $("#cards").innerHTML = list.map(({ lib, status }) => cardHtml(lib, status, now)).join("");
  else $("#week").innerHTML = empty ? "" : weekHtml(list.map((x) => x.lib), now);
}

function hoursForDay(day) {
  return day.hours.map(fmtRange).join(", ");
}

function cardHtml(lib, status, now) {
  const today = lib.days.find((d) => toIsoDate(d.date) === now.slice(0, 10)) || lib.days[0];
  const expanded = state.expanded.has(lib.id);
  const note = stripHtml(lib.note);
  const links = [
    lib.website && `<a href="${escapeHtml(lib.website)}" target="_blank" rel="noopener">Website</a>`,
    lib.mapUrl && `<a href="${escapeHtml(lib.mapUrl)}" target="_blank" rel="noopener">Map</a>`,
    lib.studyRooms && `<a href="${escapeHtml(lib.studyRooms)}" target="_blank" rel="noopener">Study rooms</a>`,
    lib.phone && `<a href="tel:${escapeHtml(lib.phone)}">${escapeHtml(lib.phone)}</a>`,
  ].filter(Boolean).join("");

  return `
    <article class="card ${status.kind}">
      <header>
        <h2>${escapeHtml(lib.name)}</h2>
        <span class="pill ${status.kind}"><span class="dot"></span>${escapeHtml(status.text)}</span>
      </header>
      <p class="today"><span>Today</span> ${escapeHtml(hoursForDay(today))}</p>
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
    return `<tr><th scope="row"><span class="dot ${status.kind}" title="${escapeHtml(status.text)}"></span>${escapeHtml(lib.name)}</th>${cells}</tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Library</th>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// ---------- Wiring ----------

function bind() {
  $("#search").addEventListener("input", (e) => { state.query = e.target.value; render(); });
  $("#open-only").addEventListener("change", (e) => { state.openOnly = e.target.checked; render(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  document.querySelectorAll("[data-view]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-pressed", b === btn));
      render();
    })
  );
  $("#cards").addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle");
    if (!btn) return;
    const id = Number(btn.dataset.id);
    state.expanded.has(id) ? state.expanded.delete(id) : state.expanded.add(id);
    render();
  });
}

bind();
load();
setInterval(render, 30 * 1000);   // keep open/closed status current
setInterval(load, REFRESH_MS);    // pick up schedule changes
