// 1) Paste your Firebase web-app config here (Firebase console → Project settings → Your apps).
//    These values are safe to expose in a browser; security comes from firestore.rules / storage.rules.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

export const SETTINGS = {
  // true  → photos go to Firebase Storage (requires the Blaze plan on new projects).
  // false → photos are compressed and stored inside Firestore (works on the free Spark plan).
  USE_STORAGE: true,

  MAP_CENTER: [16.3067, 80.4365],   // Guntur – change to your city
  MAP_ZOOM: 13,

  DUPLICATE_RADIUS_M: 100,          // reports closer than this are checked as possible duplicates
  DUPLICATE_IMAGE_SIM: 0.80,        // cosine similarity at/above this = "likely duplicate"
  RESOLVED_SIM_MAX: 0.82,           // before/after similarity below this = scene visibly changed
  MIN_AI_CONFIDENCE: 0.15           // below this the AI says "not sure" instead of guessing
};

// slaHours = deadline before a complaint is flagged as overdue.
export const CATEGORIES = [
  { id: "garbage",     label: "Garbage accumulation", icon: "🗑️", color: "#7A8B2E", dept: "Sanitation",             slaHours: 24 },
  { id: "pothole",     label: "Pothole",              icon: "🕳️", color: "#B5651D", dept: "Roads & Buildings",      slaHours: 72 },
  { id: "road",        label: "Damaged road",         icon: "🛣️", color: "#8A5A44", dept: "Roads & Buildings",      slaHours: 120 },
  { id: "streetlight", label: "Broken streetlight",   icon: "💡", color: "#D9A400", dept: "Electrical",             slaHours: 48 },
  { id: "drainage",    label: "Drainage blockage",    icon: "🌊", color: "#2A6F97", dept: "Drainage & Sewerage",    slaHours: 36 },
  { id: "water",       label: "Water leakage",        icon: "💧", color: "#1D8FE1", dept: "Water Supply",           slaHours: 24 },
  { id: "other",       label: "Other (custom issue)", icon: "📌", color: "#6B5B95", dept: "General Administration", slaHours: 96 }
];

export const STATUSES = [
  { id: "submitted",    label: "Submitted" },
  { id: "under_review", label: "Under review" },
  { id: "assigned",     label: "Assigned" },
  { id: "in_progress",  label: "In progress" },
  { id: "resolved",     label: "Resolved" }
];

export const PRIORITIES = [
  { id: "low",    label: "Low",    slaFactor: 1.5 },
  { id: "medium", label: "Medium", slaFactor: 1 },
  { id: "high",   label: "High",   slaFactor: 0.5 },
  { id: "urgent", label: "Urgent", slaFactor: 0.25 }
];

export const DEPARTMENTS = [...new Set(CATEGORIES.map(c => c.dept))];
