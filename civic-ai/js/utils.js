import { CATEGORIES, PRIORITIES } from "./config.js";

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const toMillis = t => (t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : typeof t === "number" ? t : 0);

export function fmtDate(t) {
  const ms = toMillis(t);
  return ms ? new Date(ms).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";
}

export function timeLeft(dueMs) {
  const diff = dueMs - Date.now();
  const abs = Math.abs(diff);
  const h = Math.floor(abs / 36e5), d = Math.floor(h / 24);
  const txt = d >= 1 ? `${d}d ${h % 24}h` : `${h}h ${Math.floor((abs % 36e5) / 6e4)}m`;
  return diff >= 0 ? `${txt} left` : `${txt} overdue`;
}

export function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function genRefId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(4))).map(b => b.toString(36).padStart(2, "0")).join("").slice(0, 5).toUpperCase();
  return `CIV-${ymd}-${rand}`;
}

/** Deadline in ms for a complaint, based on category SLA and priority. */
export function computeDue(createdMs, categoryId, priorityId) {
  const cat = CATEGORIES.find(c => c.id === categoryId) || CATEGORIES.at(-1);
  const pr = PRIORITIES.find(p => p.id === priorityId) || PRIORITIES[1];
  return createdMs + cat.slaHours * pr.slaFactor * 36e5;
}

export function isOverdue(c) {
  return c.status !== "resolved" && toMillis(c.dueAt) && toMillis(c.dueAt) < Date.now();
}

/** Escalation level by how long a complaint is overdue: 1 (<24h), 2 (<72h), 3 (longer). */
export function escalationLevel(c) {
  if (!isOverdue(c)) return 0;
  const h = (Date.now() - toMillis(c.dueAt)) / 36e5;
  return h < 24 ? 1 : h < 72 ? 2 : 3;
}

export function loadImageFromFile(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => res({ img, url });
    img.onerror = () => rej(new Error("That file could not be read as an image."));
    img.src = url;
  });
}

/** Downscale an image to maxDim and return a JPEG Blob + canvas (the canvas is what the AI analyses). */
export function resizeImage(img, maxDim = 1024, quality = 0.8) {
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise(res => canvas.toBlob(blob => res({ blob, canvas }), "image/jpeg", quality));
}

let toastTimer;
export function toast(msg, kind = "info") {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 4200);
}
