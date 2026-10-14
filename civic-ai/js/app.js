import {
  configured, auth, db, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, Timestamp, arrayUnion, saveImage
} from "./firebase.js";
import { CATEGORIES, STATUSES, PRIORITIES, DEPARTMENTS, SETTINGS } from "./config.js";
import { analyze, loadModels, hasCustomModel, draftDescription, verifyResolution, VERDICT_LABEL, cosine } from "./ai.js";
import {
  $, $$, esc, fmtDate, timeLeft, toMillis, haversine, genRefId, computeDue, isOverdue, escalationLevel,
  loadImageFromFile, resizeImage, toast
} from "./utils.js";

const app = $("#app");
const state = { user: null, profile: null, map: null, cache: null, cacheAt: 0, redirect: null };
const isAdmin = () => state.profile?.role === "admin";

/* ---------- small helpers ---------- */
const cat = id => CATEGORIES.find(c => c.id === id) || CATEGORIES.at(-1);
const statusLabel = id => STATUSES.find(s => s.id === id)?.label || id;
const chip = (cls, text) => `<span class="chip ${cls}">${esc(text)}</span>`;
const statusChip = c => chip(c.status, statusLabel(c.status));
const prioChip = c => chip(c.priority || "medium", (PRIORITIES.find(p => p.id === c.priority) || PRIORITIES[1]).label + " priority");
const flagChips = c => {
  const lvl = escalationLevel(c);
  return (lvl ? chip("overdue", `Overdue, level ${lvl}`) : "") + (c.escalated ? chip("overdue", "Escalated") : "");
};
const options = (list, sel) => list.map(o => `<option value="${esc(o.id ?? o)}" ${(o.id ?? o) === sel ? "selected" : ""}>${esc(o.label ?? o)}</option>`).join("");

function card(c) {
  const k = cat(c.category);
  return `<a class="card" href="#/c/${c.id}">
    <img src="${esc(c.imageUrl)}" alt="Photo of reported problem" loading="lazy">
    <div class="body">
      <span class="ref">${esc(c.refId)}</span>
      <h3>${k.icon} ${esc(c.title)}</h3>
      <div class="row-flex">${statusChip(c)}${flagChips(c)}</div>
      <p class="muted small">${esc(c.address || "Location pinned on map")}</p>
    </div></a>`;
}

async function loadComplaints(force = false) {
  if (!force && state.cache && Date.now() - state.cacheAt < 30000) return state.cache;
  const snap = await getDocs(query(collection(db, "complaints"), orderBy("createdAt", "desc"), limit(400)));
  state.cache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  state.cacheAt = Date.now();
  return state.cache;
}

function makeMap(el, center, zoom) {
  const m = L.map(el).setView(center || SETTINGS.MAP_CENTER, zoom || SETTINGS.MAP_ZOOM);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(m);
  state.map = m;
  return m;
}

const pinIcon = (c, overdue) => {
  const k = cat(c.category);
  const ring = overdue ? "border-color:#c8372d;box-shadow:0 0 0 3px rgba(200,55,45,.5);" : "";
  return L.divIcon({
    className: "", iconSize: [28, 28], iconAnchor: [14, 28], popupAnchor: [0, -26],
    html: `<div class="pin" style="background:${k.color};${ring}"><i>${k.icon}</i></div>`
  });
};

/* ---------- auth + nav ---------- */
onAuthStateChanged(auth, async u => {
  state.user = u;
  state.profile = null;
  if (u) {
    try {
      const s = await getDoc(doc(db, "users", u.uid));
      state.profile = s.exists() ? s.data() : { name: u.displayName || u.email, email: u.email, role: "citizen" };
    } catch { state.profile = { name: u.displayName || u.email, email: u.email, role: "citizen" }; }
  }
  route();
});

function renderNav(page) {
  const link = (href, label, key) => `<a href="${href}" ${page === key ? 'aria-current="page"' : ""}>${label}</a>`;
  $("#nav").innerHTML =
    link("#/", "Home", "") + link("#/report", "Report a problem", "report") + link("#/map", "Issue map", "map") +
    link("#/track", "Track", "track") +
    (state.user ? link("#/my", "My complaints", "my") : "") +
    (isAdmin() ? link("#/admin", "Admin dashboard", "admin") : "") +
    (state.user ? `<button id="logout">Log out</button>` : link("#/login", "Log in", "login"));
  $("#logout")?.addEventListener("click", async () => { await signOut(auth); location.hash = "#/"; toast("You're logged out.", "success"); });
  $("#nav").classList.remove("open");
  $("#menuBtn").setAttribute("aria-expanded", "false");
}
$("#menuBtn").addEventListener("click", () => {
  const open = $("#nav").classList.toggle("open");
  $("#menuBtn").setAttribute("aria-expanded", String(open));
});

/* ---------- router ---------- */
async function route() {
  if (state.map) { state.map.remove(); state.map = null; }
  const [, page = "", arg] = (location.hash.slice(1) || "/").split("/");
  renderNav(page);
  window.scrollTo(0, 0);
  const banner = configured ? "" :
    `<div class="notice bad" style="margin-bottom:18px"><b>Firebase is not configured yet.</b> Open <code>js/config.js</code>, paste your Firebase web-app keys, then redeploy. See README.md.</div>`;
  try {
    switch (page) {
      case "": return await viewHome(banner);
      case "login": return viewLogin(banner);
      case "report": return await viewReport(banner);
      case "my": return await viewMy(banner);
      case "map": return await viewMap(banner);
      case "track": return viewTrack(banner);
      case "c": return await viewDetail(arg, banner);
      case "admin": return await viewAdmin(banner);
      default: app.innerHTML = `${banner}<h2>Page not found</h2><p><a href="#/">Go to the home page</a></p>`;
    }
  } catch (e) {
    console.error(e);
    app.innerHTML = `${banner}<div class="notice bad"><b>Something went wrong.</b> ${esc(e.message || e)}<br>
      <span class="small">If this says "permission denied", publish firestore.rules from this project in the Firebase console.</span></div>`;
  }
}
window.addEventListener("hashchange", route);

function requireLogin(msg) {
  if (state.user) return false;
  state.redirect = location.hash || "#/";
  app.innerHTML = `<div class="panel stack"><h2>Log in to continue</h2><p>${esc(msg)}</p><a class="btn" href="#/login">Log in or create an account</a></div>`;
  return true;
}

/* ---------- home ---------- */
async function viewHome(banner) {
  let recent = "";
  try {
    const all = await loadComplaints();
    const list = all.slice(0, 6);
    recent = list.length ? `<h2>Recently reported</h2><div class="cards">${list.map(card).join("")}</div>` : "";
  } catch { /* not configured yet */ }
  app.innerHTML = `${banner}
  <section class="hero">
    <div>
      <h1>See a problem?<br>Photograph it. We'll write the complaint.</h1>
      <p class="lead">Upload a photo of a pothole, garbage pile, broken streetlight or any civic issue. AI suggests the category and drafts the description. You check it, pin the location and submit.</p>
      <div class="hero-actions">
        <a class="btn" href="#/report">Report a problem</a>
        <a class="btn ghost" href="#/map">View the issue map</a>
      </div>
    </div>
    <div class="ticket" aria-hidden="true">
      <div class="row"><span>Reference</span><b>CIV-20261014-7K2QX</b></div>
      <div class="row"><span>AI suggestion</span><b>🕳️ Pothole (86%)</b></div>
      <div class="row"><span>Status</span><b>Assigned</b></div>
      <div class="row"><span>Deadline</span><b>2d 4h left</b></div>
    </div>
  </section>
  <section class="steps">
    <div class="step"><h3>Snap and describe</h3><p>AI turns your photo into a draft complaint you can edit.</p></div>
    <div class="step"><h3>Pin the spot</h3><p>Use GPS or tap the map. Repeat reports nearby are flagged so work isn't doubled.</p></div>
    <div class="step"><h3>Follow it to the fix</h3><p>Track status, see overdue items escalated, and rate the result.</p></div>
  </section>
  ${recent}`;
}

/* ---------- login / register ---------- */
function viewLogin(banner, mode = "login") {
  const reg = mode === "register";
  app.innerHTML = `${banner}
  <div class="panel stack" style="max-width:460px;margin:0 auto">
    <h2>${reg ? "Create your account" : "Log in"}</h2>
    <form id="authForm" class="stack">
      ${reg ? `<div class="field"><label for="name">Full name</label><input id="name" required autocomplete="name"></div>` : ""}
      <div class="field"><label for="email">Email</label><input id="email" type="email" required autocomplete="email"></div>
      <div class="field"><label for="pw">Password</label><input id="pw" type="password" required minlength="6" autocomplete="${reg ? "new-password" : "current-password"}"><p class="hint">${reg ? "At least 6 characters." : ""}</p></div>
      <button class="btn" type="submit">${reg ? "Create account" : "Log in"}</button>
    </form>
    <div class="row-flex spread small">
      <button class="btn ghost small" id="swap">${reg ? "I already have an account" : "Create a new account"}</button>
      ${reg ? "" : `<button class="btn ghost small" id="forgot">Forgot password</button>`}
    </div>
  </div>`;
  $("#swap").onclick = () => viewLogin(banner, reg ? "login" : "register");
  $("#forgot")?.addEventListener("click", async () => {
    const email = $("#email").value.trim();
    if (!email) return toast("Enter your email first, then press Forgot password.", "error");
    try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent.", "success"); }
    catch (e) { toast(authError(e), "error"); }
  });
  $("#authForm").onsubmit = async ev => {
    ev.preventDefault();
    const email = $("#email").value.trim(), pw = $("#pw").value;
    try {
      if (reg) {
        const name = $("#name").value.trim();
        const cred = await createUserWithEmailAndPassword(auth, email, pw);
        await updateProfile(cred.user, { displayName: name });
        await setDoc(doc(db, "users", cred.user.uid), { name, email, role: "citizen", createdAt: serverTimestamp() });
        state.profile = { name, email, role: "citizen" };
      } else await signInWithEmailAndPassword(auth, email, pw);
      const to = state.redirect || "#/"; state.redirect = null;
      location.hash = to;
      toast("Welcome!", "success");
    } catch (e) { toast(authError(e), "error"); }
  };
}
const authError = e => ({
  "auth/invalid-credential": "Email or password is incorrect.",
  "auth/email-already-in-use": "An account with this email already exists. Try logging in.",
  "auth/weak-password": "Choose a password with at least 6 characters.",
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/too-many-requests": "Too many attempts. Wait a few minutes and try again.",
  "auth/network-request-failed": "Network problem. Check your connection and try again."
}[e.code] || e.message || "Something went wrong.");

/* ---------- report a problem ---------- */
async function viewReport(banner) {
  if (requireLogin("You need an account so you can track your complaints and get updates.")) return;
  const draft = { blob: null, ai: null, lat: null, lng: null, descAuto: true, addrAuto: true, ignoreDupes: false };
  app.innerHTML = `${banner}
  <h2>Report a problem</h2>
  <form id="rf" class="grid2" novalidate>
    <div class="stack">
      <div class="panel">
        <div class="field"><label for="photo">Photo of the problem</label>
          <input id="photo" type="file" accept="image/*" capture="environment">
          <p class="hint">AI will suggest a category and draft a description. You can change both.</p></div>
        <img id="prev" class="preview" alt="Preview of your photo" hidden>
        <div id="aiOut" style="margin-top:12px"></div>
      </div>
      <div class="panel">
        <div class="field"><label for="cat">Category</label>
          <select id="cat"><option value="">Choose a category</option>${options(CATEGORIES, "")}</select></div>
        <div class="field" id="customWrap" hidden><label for="ctitle">Short title for your issue</label><input id="ctitle" maxlength="80" placeholder="e.g. Fallen tree blocking footpath"></div>
        <div class="field"><label for="desc">Description</label><textarea id="desc" maxlength="1000" required></textarea></div>
      </div>
    </div>
    <div class="stack">
      <div class="panel">
        <div class="row-flex spread"><label style="margin:0">Location</label>
          <button class="btn ghost small" type="button" id="gps">Use my GPS location</button></div>
        <p class="hint" id="locHint">Tap the map to drop the pin, or drag it to the exact spot.</p>
        <div id="map" class="map" style="margin:10px 0"></div>
        <div class="field"><label for="addr">Address or landmark</label><input id="addr" maxlength="200" placeholder="Near the bus stop on Main Road"></div>
      </div>
      <div id="dupOut"></div>
      <button class="btn" type="submit" id="submitBtn">Submit complaint</button>
    </div>
  </form>`;

  /* map + marker */
  const map = makeMap($("#map"));
  let marker = null;
  let geoTimer;
  const setPoint = (lat, lng, zoom) => {
    draft.lat = lat; draft.lng = lng;
    if (!marker) {
      marker = L.marker([lat, lng], { draggable: true }).addTo(map);
      marker.on("dragend", () => { const p = marker.getLatLng(); setPoint(p.lat, p.lng); });
    } else marker.setLatLng([lat, lng]);
    if (zoom) map.setView([lat, lng], zoom);
    $("#locHint").textContent = `Pin set at ${lat.toFixed(5)}, ${lng.toFixed(5)}. Drag it to adjust.`;
    clearTimeout(geoTimer);
    geoTimer = setTimeout(() => reverseGeocode(lat, lng), 600);
  };
  async function reverseGeocode(lat, lng) {
    if (!draft.addrAuto) return;
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&lat=${lat}&lon=${lng}`);
      const j = await r.json();
      if (j.display_name && draft.addrAuto) { $("#addr").value = j.display_name.split(",").slice(0, 4).join(",").trim(); refreshDraft(); }
    } catch { /* address lookup is optional */ }
  }
  map.on("click", e => setPoint(e.latlng.lat, e.latlng.lng));
  $("#addr").addEventListener("input", () => { draft.addrAuto = false; });
  $("#gps").onclick = () => {
    if (!navigator.geolocation) return toast("This browser can't share your location. Tap the map instead.", "error");
    $("#locHint").textContent = "Finding your location…";
    navigator.geolocation.getCurrentPosition(
      p => setPoint(p.coords.latitude, p.coords.longitude, 17),
      () => { $("#locHint").textContent = "Location permission was denied. Tap the map to drop the pin instead."; toast("Location permission denied. Tap the map instead.", "error"); },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  /* category + description */
  const syncCustom = () => { $("#customWrap").hidden = $("#cat").value !== "other"; };
  function refreshDraft() {
    const c = $("#cat").value;
    if (draft.descAuto && c) $("#desc").value = draftDescription(c, draft.ai, $("#addr").value.trim());
  }
  $("#cat").onchange = () => { syncCustom(); refreshDraft(); draft.ignoreDupes = false; };
  $("#desc").addEventListener("input", () => { draft.descAuto = false; });

  /* photo → AI */
  $("#photo").onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $("#aiOut");
    out.innerHTML = `<div class="ai-box"><span class="spinner"></span>Reading your photo with AI… the first run downloads the model and can take a few seconds.</div>`;
    try {
      const { img, url } = await loadImageFromFile(file);
      const { blob, canvas } = await resizeImage(img, SETTINGS.USE_STORAGE ? 1280 : 800, SETTINGS.USE_STORAGE ? 0.82 : 0.68);
      draft.blob = blob;
      $("#prev").src = url; $("#prev").hidden = false;
      draft.ai = await analyze(canvas);
      const a = draft.ai;
      if (a.category) {
        const k = cat(a.category);
        $("#cat").value = a.category; syncCustom(); refreshDraft();
        out.innerHTML = `<div class="ai-box"><h3>AI suggests: ${k.icon} ${esc(k.label)}</h3>
          <div class="bar" aria-hidden="true"><span style="width:${Math.round(a.confidence * 100)}%"></span></div>
          <p class="small muted" style="margin:6px 0 0">Confidence ${Math.round(a.confidence * 100)}%. ${a.source === "custom" ? "From the trained civic model." : "Generic image model, so please double-check the category."} The category and description below are drafts you can edit.</p></div>`;
      } else {
        out.innerHTML = `<div class="ai-box"><h3>AI isn't sure what this shows</h3>
          <p class="small muted" style="margin:0">Choose a category below and describe the problem in your own words. If it doesn't fit any category, pick "Other".</p></div>`;
      }
    } catch (e) {
      draft.ai = null;
      out.innerHTML = `<div class="notice">AI analysis isn't available right now (${esc(e.message)}). You can still choose a category and describe the problem yourself.</div>`;
    }
  };
  loadModels().catch(() => {}); // warm up in the background

  /* submit */
  $("#rf").onsubmit = async ev => {
    ev.preventDefault();
    const catId = $("#cat").value, desc = $("#desc").value.trim();
    const customTitle = $("#ctitle").value.trim();
    if (!draft.blob) return toast("Add a photo of the problem first.", "error");
    if (!catId) return toast("Choose a category.", "error");
    if (catId === "other" && !customTitle) return toast("Give your custom issue a short title.", "error");
    if (desc.length < 10) return toast("Add a short description (at least 10 characters).", "error");
    if (draft.lat == null) return toast("Drop the pin on the map or use GPS.", "error");

    const btn = $("#submitBtn");
    btn.disabled = true;
    try {
      let dupOf = null;
      if (!draft.ignoreDupes) {
        btn.textContent = "Checking for similar reports…";
        const dupes = findDuplicates(await loadComplaints(true), { lat: draft.lat, lng: draft.lng, category: catId, embedding: draft.ai?.embedding });
        if (dupes.length) { showDuplicates(dupes); btn.disabled = false; btn.textContent = "Submit complaint"; return; }
      } else dupOf = draft.dupOf || null;
      await createComplaint(dupOf);
    } catch (e) {
      console.error(e);
      toast(e.code === "permission-denied" ? "Permission denied. Make sure the Firestore and Storage rules are published." : (e.message || "Could not submit."), "error");
      btn.disabled = false; btn.textContent = "Submit complaint";
    }
  };

  function showDuplicates(dupes) {
    $("#dupOut").innerHTML = `<div class="notice stack">
      <b>Someone may have already reported this.</b>
      <p class="small" style="margin:0">Adding your support to an existing report helps administrators prioritise it. If yours is a different problem, submit it as new.</p>
      ${dupes.map(d => `<div class="dupe">
        <img src="${esc(d.c.imageUrl)}" alt="">
        <div style="flex:1"><a href="#/c/${d.c.id}" target="_blank" rel="noopener"><b>${esc(d.c.refId)}</b></a> ${statusChip(d.c)}
          <div class="small muted">${Math.round(d.dist)} m away. ${d.level === "likely" ? `Photo ${Math.round(d.sim * 100)}% similar.` : "Same category nearby."}</div></div>
        <button type="button" class="btn small" data-support="${d.c.id}">Support this report</button></div>`).join("")}
      <button type="button" class="btn ghost" id="newAnyway">This is a different problem. Submit as new.</button></div>`;
    $$("[data-support]").forEach(b => b.onclick = async () => {
      b.disabled = true;
      try { await supportComplaint(b.dataset.support); toast("Thanks, your support was added.", "success"); location.hash = `#/c/${b.dataset.support}`; }
      catch (e) { toast(e.message, "error"); b.disabled = false; }
    });
    $("#newAnyway").onclick = () => { draft.ignoreDupes = true; draft.dupOf = dupes[0].c.id; $("#dupOut").innerHTML = ""; $("#rf").requestSubmit(); };
    $("#dupOut").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function createComplaint(duplicateOf) {
    const btn = $("#submitBtn");
    btn.textContent = "Uploading photo…";
    const catId = $("#cat").value, k = cat(catId);
    const imageUrl = await saveImage(draft.blob, `complaints/${state.user.uid}/${Date.now()}.jpg`);
    btn.textContent = "Saving complaint…";
    const now = Date.now();
    const refId = genRefId();
    const data = {
      refId, uid: state.user.uid, userName: state.profile?.name || state.user.email,
      category: catId, custom: catId === "other",
      title: catId === "other" ? $("#ctitle").value.trim() : k.label,
      description: $("#desc").value.trim(),
      lat: draft.lat, lng: draft.lng, address: $("#addr").value.trim(),
      imageUrl, embedding: draft.ai?.embedding || null,
      aiCategory: draft.ai?.category || null, aiConfidence: draft.ai ? Math.round(draft.ai.confidence * 100) / 100 : null,
      aiSource: draft.ai?.source || null,
      status: "submitted", priority: "medium", department: k.dept,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      dueAt: Timestamp.fromMillis(computeDue(now, catId, "medium")),
      escalated: false, supporters: [], duplicateOf: duplicateOf || null,
      history: [{ status: "submitted", at: Timestamp.fromMillis(now), note: "Complaint submitted", by: state.profile?.name || "Citizen" }]
    };
    const ref = await addDoc(collection(db, "complaints"), data);
    state.cache = null;
    app.innerHTML = `<div class="panel stack" style="max-width:560px;margin:0 auto">
      <h2>Complaint submitted</h2>
      <p>Your reference ID is</p>
      <p style="font:800 2rem var(--font-head);margin:0">${esc(refId)}</p>
      <p class="muted">Keep this ID to track progress. The deadline for this category is ${k.slaHours} hours. If it isn't resolved by then, it is flagged for administrators.</p>
      <div class="row-flex"><a class="btn" href="#/c/${ref.id}">View my complaint</a><a class="btn ghost" href="#/report">Report another</a></div></div>`;
  }
}

function findDuplicates(all, { lat, lng, category, embedding }) {
  const out = [];
  for (const c of all) {
    if (c.status === "resolved" || c.lat == null) continue;
    const dist = haversine(lat, lng, c.lat, c.lng);
    if (dist > SETTINGS.DUPLICATE_RADIUS_M) continue;
    const sim = embedding && c.embedding ? cosine(embedding, c.embedding) : 0;
    if (sim >= SETTINGS.DUPLICATE_IMAGE_SIM) out.push({ c, dist, sim, level: "likely" });
    else if (c.category === category) out.push({ c, dist, sim, level: "possible" });
  }
  return out.sort((a, b) => (a.level === b.level ? a.dist - b.dist : a.level === "likely" ? -1 : 1)).slice(0, 3);
}

async function supportComplaint(id) {
  await updateDoc(doc(db, "complaints", id), { supporters: arrayUnion(state.user.uid) });
  state.cache = null;
}

/* ---------- my complaints ---------- */
async function viewMy(banner) {
  if (requireLogin("Log in to see the complaints you've submitted.")) return;
  const snap = await getDocs(query(collection(db, "complaints"), where("uid", "==", state.user.uid)));
  const list = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  app.innerHTML = `${banner}
  <div class="row-flex spread"><h2>My complaints</h2><a class="btn" href="#/report">Report a problem</a></div>
  ${list.length ? `<div class="cards">${list.map(card).join("")}</div>` :
    `<div class="panel stack"><p>You haven't reported anything yet.</p><a class="btn" href="#/report">Report your first problem</a></div>`}
  <div class="panel stack" style="margin-top:28px;max-width:460px">
    <h3>Your profile</h3>
    <form id="pf" class="stack">
      <div class="field"><label for="pname">Name</label><input id="pname" value="${esc(state.profile?.name || "")}" required></div>
      <div class="field"><label>Email</label><input value="${esc(state.user.email)}" disabled></div>
      <button class="btn small" type="submit">Save profile</button>
    </form></div>`;
  $("#pf").onsubmit = async ev => {
    ev.preventDefault();
    const name = $("#pname").value.trim();
    try {
      await updateProfile(auth.currentUser, { displayName: name });
      await setDoc(doc(db, "users", state.user.uid), { name, email: state.user.email, role: state.profile?.role || "citizen" }, { merge: true });
      state.profile = { ...state.profile, name };
      toast("Profile saved.", "success");
    } catch (e) { toast(e.message, "error"); }
  };
}

/* ---------- civic issue map ---------- */
async function viewMap(banner) {
  const all = await loadComplaints();
  app.innerHTML = `${banner}
  <h2>Civic issue map</h2>
  <div class="filters">
    <select id="fc" aria-label="Filter by category"><option value="">All categories</option>${options(CATEGORIES, "")}</select>
    <select id="fs" aria-label="Filter by status"><option value="">All statuses</option><option value="open">Open only</option>${options(STATUSES, "")}</select>
  </div>
  <div id="map" class="map tall"></div>
  <div class="legend">${CATEGORIES.map(k => `<span><span class="dot" style="background:${k.color}"></span>${esc(k.label)}</span>`).join("")}
    <span><span class="dot" style="background:#fff;border:3px solid #c8372d"></span>Overdue</span></div>
  <p class="muted small" id="mapCount"></p>`;
  const map = makeMap($("#map"));
  const layer = L.layerGroup().addTo(map);
  function draw() {
    layer.clearLayers();
    const fc = $("#fc").value, fs = $("#fs").value;
    const shown = all.filter(c => c.lat != null && (!fc || c.category === fc) &&
      (!fs || (fs === "open" ? c.status !== "resolved" : c.status === fs)));
    const pts = shown.map(c => {
      const m = L.marker([c.lat, c.lng], { icon: pinIcon(c, isOverdue(c)) }).addTo(layer);
      m.bindPopup(`<b>${esc(c.title)}</b><br>${esc(statusLabel(c.status))}<br><a href="#/c/${c.id}">${esc(c.refId)}</a>`);
      return [c.lat, c.lng];
    });
    $("#mapCount").textContent = `${shown.length} report${shown.length === 1 ? "" : "s"} shown.`;
    return pts;
  }
  const pts = draw();
  if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 16 });
  $("#fc").onchange = $("#fs").onchange = draw;
}

/* ---------- track by reference ID ---------- */
function viewTrack(banner) {
  app.innerHTML = `${banner}
  <div class="panel stack" style="max-width:520px;margin:0 auto">
    <h2>Track a complaint</h2>
    <form id="tf" class="stack">
      <div class="field"><label for="ref">Reference ID</label><input id="ref" placeholder="CIV-20261014-7K2QX" required></div>
      <button class="btn" type="submit">Find complaint</button>
    </form><div id="tOut"></div></div>`;
  $("#tf").onsubmit = async ev => {
    ev.preventDefault();
    const ref = $("#ref").value.trim().toUpperCase();
    try {
      const snap = await getDocs(query(collection(db, "complaints"), where("refId", "==", ref), limit(1)));
      if (snap.empty) return $("#tOut").innerHTML = `<div class="notice">No complaint found with ID <b>${esc(ref)}</b>. Check the ID and try again.</div>`;
      location.hash = `#/c/${snap.docs[0].id}`;
    } catch (e) { toast(e.message, "error"); }
  };
}

/* ---------- complaint detail ---------- */
async function viewDetail(id, banner) {
  const snap = await getDoc(doc(db, "complaints", id));
  if (!snap.exists()) { app.innerHTML = `${banner}<h2>Complaint not found</h2><a href="#/track">Search by reference ID</a>`; return; }
  const c = { id, ...snap.data() };
  const k = cat(c.category);
  const owner = state.user && c.uid === state.user.uid;
  const supported = state.user && (c.supporters || []).includes(state.user.uid);
  const v = c.verification;

  app.innerHTML = `${banner}
  <p><a href="${isAdmin() ? "#/admin" : "#/my"}">Back</a></p>
  <div class="row-flex spread"><div><span class="muted small">${esc(c.refId)}</span><h2 style="margin:0">${k.icon} ${esc(c.title)}</h2></div>
    <div class="row-flex">${statusChip(c)}${prioChip(c)}${flagChips(c)}</div></div>
  <div class="grid2" style="margin-top:18px">
    <div class="stack">
      <div class="panel stack">
        <img class="preview" src="${esc(c.imageUrl)}" alt="Photo of the reported problem">
        ${c.resolutionImageUrl ? `<div><h3>After the fix</h3><img class="preview" src="${esc(c.resolutionImageUrl)}" alt="Photo after resolution"></div>` : ""}
        ${v ? `<div class="notice ${v.verdict === "appears_resolved" ? "ok" : v.verdict === "uncertain" ? "" : "bad"}">
          <b>AI check: ${esc(VERDICT_LABEL[v.verdict] || v.verdict)}</b>
          <ul class="small" style="margin:6px 0 0 18px;padding:0">${(v.reasons || []).map(r => `<li>${esc(r)}</li>`).join("")}</ul>
          <p class="small muted" style="margin:6px 0 0">This is an automated aid, reviewed by an administrator.</p></div>` : ""}
      </div>
      <div class="panel"><h3>Progress</h3>
        <ul class="timeline">${(c.history || []).map(h => `<li><b>${esc(statusLabel(h.status))}</b> <span class="muted small">${esc(fmtDate(h.at))}${h.by ? ` by ${esc(h.by)}` : ""}</span><br>${esc(h.note || "")}</li>`).join("")}</ul></div>
    </div>
    <div class="stack">
      <div class="panel stack">
        <p style="margin:0;white-space:pre-wrap">${esc(c.description)}</p>
        <div class="small muted">
          <div>Department: <b>${esc(c.department || k.dept)}</b></div>
          <div>Reported: ${esc(fmtDate(c.createdAt))}</div>
          <div>Deadline: ${esc(fmtDate(c.dueAt))}${c.status !== "resolved" ? ` (${esc(timeLeft(toMillis(c.dueAt)))})` : ""}</div>
          <div>Address: ${esc(c.address || "Pinned on map")}</div>
          <div>People affected / supporting: <b>${1 + (c.supporters || []).length}</b></div>
          ${c.aiCategory ? `<div>AI suggestion at submission: ${esc(cat(c.aiCategory).label)} (${Math.round((c.aiConfidence || 0) * 100)}%)</div>` : ""}
        </div>
        ${state.user && !owner && !supported && c.status !== "resolved" ? `<button class="btn small" id="support">I'm affected too. Support this report</button>` : ""}
        <div id="map" class="map" style="height:240px"></div>
      </div>
      ${owner && c.status === "resolved" ? feedbackPanel(c) : ""}
      ${isAdmin() ? adminPanel(c) : ""}
    </div>
  </div>`;

  const map = makeMap($("#map"), [c.lat, c.lng], 16);
  L.marker([c.lat, c.lng], { icon: pinIcon(c, isOverdue(c)) }).addTo(map);

  $("#support")?.addEventListener("click", async () => {
    try { await supportComplaint(id); toast("Thanks, your support was added.", "success"); route(); } catch (e) { toast(e.message, "error"); }
  });
  if (owner && c.status === "resolved" && !c.feedback) wireFeedback(c);
  if (isAdmin()) wireAdmin(c);
}

function feedbackPanel(c) {
  if (c.feedback) return `<div class="panel"><h3>Your feedback</h3><div class="stars" aria-label="${c.feedback.rating} out of 5">${"★".repeat(c.feedback.rating)}${"☆".repeat(5 - c.feedback.rating)}</div><p class="muted">${esc(c.feedback.comment || "")}</p></div>`;
  return `<div class="panel stack"><h3>Was it fixed properly?</h3>
    <div class="stars" id="stars" role="group" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-v="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
    <div class="field"><label for="fb">Comments (optional)</label><textarea id="fb" style="min-height:80px" maxlength="500"></textarea></div>
    <button class="btn" id="sendFb">Send feedback</button></div>`;
}
function wireFeedback(c) {
  let rating = 0;
  $$("#stars button").forEach(b => b.onclick = () => { rating = +b.dataset.v; $$("#stars button").forEach(x => x.classList.toggle("on", +x.dataset.v <= rating)); });
  $("#sendFb").onclick = async () => {
    if (!rating) return toast("Pick a star rating first.", "error");
    try {
      await updateDoc(doc(db, "complaints", c.id), { feedback: { rating, comment: $("#fb").value.trim(), at: Timestamp.now() } });
      state.cache = null; toast("Thanks for your feedback.", "success"); route();
    } catch (e) { toast(e.message, "error"); }
  };
}

/* ---------- admin: edit panel on detail page ---------- */
function adminPanel(c) {
  return `<div class="panel stack" style="border:2px solid var(--ink)">
    <h3>Administrator actions</h3>
    <div class="grid2" style="gap:12px">
      <div class="field"><label for="a_status">Status</label><select id="a_status">${options(STATUSES, c.status)}</select></div>
      <div class="field"><label for="a_prio">Priority</label><select id="a_prio">${options(PRIORITIES, c.priority || "medium")}</select></div>
    </div>
    <div class="field"><label for="a_dept">Responsible department</label><select id="a_dept">${options(DEPARTMENTS, c.department || cat(c.category).dept)}</select></div>
    <div class="field"><label for="a_note">Update note (visible to the citizen)</label><input id="a_note" maxlength="300" placeholder="Crew scheduled for Thursday morning"></div>
    <div class="field"><label for="a_after">After-fix photo</label><input id="a_after" type="file" accept="image/*" capture="environment">
      <p class="hint">Optional. AI compares it with the original photo and gives a suggestion. You decide.</p></div>
    <img id="a_prev" class="preview" alt="After-fix preview" hidden>
    <div id="a_ai"></div>
    <div class="row-flex">
      <button class="btn" id="a_save">Save update</button>
      ${c.status !== "resolved" && !c.escalated ? `<button class="btn ghost" id="a_esc" type="button">Escalate now</button>` : ""}
    </div></div>`;
}

function wireAdmin(c) {
  let after = null; // { blob, verification }
  $("#a_after").onchange = async ev => {
    const file = ev.target.files[0];
    if (!file) return;
    const out = $("#a_ai");
    out.innerHTML = `<div class="ai-box"><span class="spinner"></span>Comparing the photos…</div>`;
    try {
      const { img, url } = await loadImageFromFile(file);
      const { blob, canvas } = await resizeImage(img, SETTINGS.USE_STORAGE ? 1280 : 800, SETTINGS.USE_STORAGE ? 0.82 : 0.68);
      $("#a_prev").src = url; $("#a_prev").hidden = false;
      if (!c.embedding?.length) {
        after = { blob, verification: null };
        out.innerHTML = `<div class="notice">The original photo has no AI fingerprint, so it can't be compared automatically. Review the photos yourself.</div>`;
        return;
      }
      const ai = await analyze(canvas);
      const verification = verifyResolution(c.embedding, ai, c.category);
      after = { blob, verification };
      out.innerHTML = `<div class="ai-box"><h3>AI check: ${esc(VERDICT_LABEL[verification.verdict])}</h3>
        <ul class="small" style="margin:4px 0 0 18px;padding:0">${verification.reasons.map(r => `<li>${esc(r)}</li>`).join("")}</ul>
        <p class="small muted" style="margin:6px 0 0">A suggestion only. Look at both photos before marking this resolved.</p></div>`;
    } catch (e) { out.innerHTML = `<div class="notice bad">${esc(e.message)}</div>`; }
  };

  $("#a_save").onclick = async () => {
    const status = $("#a_status").value, priority = $("#a_prio").value, department = $("#a_dept").value, note = $("#a_note").value.trim();
    if (status === "resolved" && after?.verification?.verdict === "likely_not_resolved" &&
      !confirm("The AI check suggests this may NOT be resolved. Mark it resolved anyway?")) return;
    const btn = $("#a_save"); btn.disabled = true; btn.textContent = "Saving…";
    try {
      const changes = [];
      if (status !== c.status) changes.push(`Status changed to ${statusLabel(status)}`);
      if (priority !== (c.priority || "medium")) changes.push(`Priority set to ${priority}`);
      if (department !== (c.department || cat(c.category).dept)) changes.push(`Assigned to ${department}`);
      const upd = {
        status, priority, department, updatedAt: serverTimestamp(),
        dueAt: Timestamp.fromMillis(computeDue(toMillis(c.createdAt) || Date.now(), c.category, priority)),
        history: arrayUnion({ status, at: Timestamp.now(), note: note || changes.join(". ") || "Updated", by: state.profile?.name || "Administrator" })
      };
      if (status === "resolved") upd.resolvedAt = serverTimestamp();
      if (after) {
        upd.resolutionImageUrl = await saveImage(after.blob, `resolutions/${c.id}-${Date.now()}.jpg`);
        if (after.verification) upd.verification = { ...after.verification, reviewedBy: state.profile?.name || "Administrator" };
      }
      await updateDoc(doc(db, "complaints", c.id), upd);
      state.cache = null; toast("Complaint updated.", "success"); route();
    } catch (e) { toast(e.message, "error"); btn.disabled = false; btn.textContent = "Save update"; }
  };

  $("#a_esc")?.addEventListener("click", async () => {
    try {
      await updateDoc(doc(db, "complaints", c.id), {
        escalated: true, escalatedAt: serverTimestamp(), updatedAt: serverTimestamp(),
        history: arrayUnion({ status: c.status, at: Timestamp.now(), note: "Escalated for administrative attention", by: state.profile?.name || "Administrator" })
      });
      state.cache = null; toast("Escalated.", "success"); route();
    } catch (e) { toast(e.message, "error"); }
  });
}

/* ---------- admin dashboard ---------- */
async function viewAdmin(banner) {
  if (requireLogin("Administrators must log in.")) return;
  if (!isAdmin()) {
    app.innerHTML = `${banner}<div class="panel stack"><h2>Administrators only</h2>
      <p>Your account is a citizen account. To make an account an administrator, open the Firestore <code>users</code> collection in the Firebase console and set <code>role</code> to <code>admin</code> for that user.</p></div>`;
    return;
  }
  const all = await loadComplaints(true);
  const open = all.filter(c => c.status !== "resolved");
  const overdue = open.filter(isOverdue);
  const rated = all.filter(c => c.feedback?.rating);
  const avg = rated.length ? (rated.reduce((s, c) => s + c.feedback.rating, 0) / rated.length).toFixed(1) : "none yet";

  // recurring problem areas: same category within ~100 m grid cell, 3+ reports
  const groups = {};
  for (const c of all) {
    if (c.lat == null) continue;
    const key = `${c.category}|${c.lat.toFixed(3)}|${c.lng.toFixed(3)}`;
    (groups[key] ||= []).push(c);
  }
  const hotspots = Object.values(groups).filter(g => g.length >= 3).sort((a, b) => b.length - a.length).slice(0, 5);

  app.innerHTML = `${banner}
  <h2>Admin dashboard</h2>
  <div class="stats">
    <div class="stat"><b>${all.length}</b>Total complaints</div>
    <div class="stat"><b>${open.length}</b>Open</div>
    <div class="stat bad"><b>${overdue.length}</b>Overdue</div>
    <div class="stat"><b>${all.length - open.length}</b>Resolved</div>
    <div class="stat"><b>${avg}</b>Average rating</div>
  </div>
  ${hotspots.length ? `<div class="panel" style="margin-bottom:20px"><h3>Recurring problem areas</h3>
    <ul style="margin:0;padding-left:20px">${hotspots.map(g => `<li>${cat(g[0].category).icon} ${esc(cat(g[0].category).label)}: <b>${g.length} reports</b> near ${esc(g[0].address || `${g[0].lat.toFixed(4)}, ${g[0].lng.toFixed(4)}`)} <a href="#/c/${g[0].id}">view latest</a></li>`).join("")}</ul></div>` : ""}
  <div class="filters">
    <input id="q" type="search" placeholder="Search ID, title or address" aria-label="Search">
    <select id="fs" aria-label="Status"><option value="">All statuses</option><option value="open">Open only</option><option value="overdue">Overdue only</option>${options(STATUSES, "")}</select>
    <select id="fc" aria-label="Category"><option value="">All categories</option>${options(CATEGORIES, "")}</select>
    <select id="fd" aria-label="Department"><option value="">All departments</option>${options(DEPARTMENTS, "")}</select>
  </div>
  <div class="table-wrap"><table><thead><tr><th>ID</th><th>Issue</th><th>Status</th><th>Priority</th><th>Department</th><th>Deadline</th></tr></thead><tbody id="rows"></tbody></table></div>`;

  const prioRank = { urgent: 0, high: 1, medium: 2, low: 3 };
  function draw() {
    const q = $("#q").value.trim().toLowerCase(), fs = $("#fs").value, fc = $("#fc").value, fd = $("#fd").value;
    const rows = all.filter(c =>
      (!q || `${c.refId} ${c.title} ${c.address}`.toLowerCase().includes(q)) &&
      (!fs || (fs === "open" ? c.status !== "resolved" : fs === "overdue" ? isOverdue(c) : c.status === fs)) &&
      (!fc || c.category === fc) && (!fd || (c.department || cat(c.category).dept) === fd))
      .sort((a, b) => (escalationLevel(b) - escalationLevel(a)) ||
        ((a.status === "resolved") - (b.status === "resolved")) ||
        (prioRank[a.priority || "medium"] - prioRank[b.priority || "medium"]) ||
        (toMillis(a.dueAt) - toMillis(b.dueAt)));
    $("#rows").innerHTML = rows.length ? rows.map(c => `<tr data-id="${c.id}" tabindex="0">
      <td><b>${esc(c.refId)}</b></td><td>${cat(c.category).icon} ${esc(c.title)}<div class="small muted">${esc(c.address || "")}</div></td>
      <td>${statusChip(c)}</td><td>${prioChip(c)}</td><td>${esc(c.department || cat(c.category).dept)}</td>
      <td>${c.status === "resolved" ? "Done" : `${esc(timeLeft(toMillis(c.dueAt)))} ${flagChips(c)}`}</td></tr>`).join("")
      : `<tr><td colspan="6" class="muted">No complaints match these filters.</td></tr>`;
    $$("#rows tr[data-id]").forEach(r => {
      const go = () => (location.hash = `#/c/${r.dataset.id}`);
      r.onclick = go; r.onkeydown = e => { if (e.key === "Enter") go(); };
    });
  }
  ["#q", "#fs", "#fc", "#fd"].forEach(s => $(s).addEventListener("input", draw));
  draw();
}
