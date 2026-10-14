// In-browser AI using TensorFlow.js.
//  • MobileNetV2 (generic, pre-trained) → image embeddings used for duplicate detection and
//    before/after comparison, plus a keyword-based fallback for category suggestions.
//  • Optional custom Keras model (see /ml) converted to TF.js and placed in /model → used for
//    category suggestions when present. Train it on your own labelled civic photos for real accuracy.
import { CATEGORIES, SETTINGS } from "./config.js";

let mobilenetModel = null;
let customModel = null;
let customLabels = null;
let loading = null;

// Fallback: map generic ImageNet class names to civic categories. This is a rough heuristic.
const KEYWORDS = {
  garbage:     ["trash", "ashcan", "garbage", "dumpster", "bin", "plastic bag", "waste", "barrel", "bucket", "crate", "carton", "packet", "paper towel"],
  pothole:     ["pothole", "crater", "gravel", "mud", "sandbar", "dirt"],
  road:        ["pavement", "sidewalk", "asphalt", "road", "street", "crosswalk", "speedway", "alley", "viaduct", "parking meter"],
  streetlight: ["street sign", "traffic light", "lamp", "torch", "spotlight", "flagpole", "pole", "beacon", "lighter", "searchlight"],
  drainage:    ["manhole", "sewer", "drain", "grate", "sink", "storm", "gutter", "plunger", "toilet"],
  water:       ["fountain", "water", "hose", "puddle", "pool", "lakeside", "geyser", "spout", "tap", "faucet", "sluice", "dam"]
};

function waitFor(test, ms = 15000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    (function poll() {
      if (test()) return res();
      if (Date.now() - t0 > ms) return rej(new Error("AI libraries failed to load. Check your internet connection."));
      setTimeout(poll, 100);
    })();
  });
}

export function loadModels() {
  if (!loading) {
    loading = (async () => {
      await waitFor(() => window.tf && window.mobilenet);
      mobilenetModel = await window.mobilenet.load({ version: 2, alpha: 1.0 });
      try {
        const [m, l] = await Promise.all([
          window.tf.loadLayersModel("model/model.json"),
          fetch("model/labels.json").then(r => { if (!r.ok) throw new Error("no labels"); return r.json(); })
        ]);
        customModel = m;
        customLabels = l;
      } catch { /* no custom model deployed – the generic fallback is used */ }
      return { custom: !!customModel };
    })();
  }
  return loading;
}

export const hasCustomModel = () => !!customModel;

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

async function embed(img) {
  const t = mobilenetModel.infer(img, true);
  const arr = Array.from(await t.data());
  t.dispose();
  const norm = Math.sqrt(arr.reduce((s, v) => s + v * v, 0)) || 1;
  return arr.map(v => Math.round((v / norm) * 1000) / 1000);
}

async function classifyCustom(img) {
  const tf = window.tf;
  const input = tf.tidy(() => tf.browser.fromPixels(img).resizeBilinear([224, 224]).toFloat().div(127.5).sub(1).expandDims(0));
  const out = customModel.predict(input);
  const probs = Array.from(await out.data());
  input.dispose(); out.dispose();
  const ranked = probs.map((p, i) => ({ label: customLabels[i], p })).sort((a, b) => b.p - a.p);
  return { category: ranked[0].label, confidence: ranked[0].p, predictions: ranked.slice(0, 3), source: "custom" };
}

async function classifyGeneric(img) {
  const preds = await mobilenetModel.classify(img, 10);
  const scores = {};
  for (const p of preds) {
    const name = p.className.toLowerCase();
    for (const [cat, words] of Object.entries(KEYWORDS)) {
      if (words.some(w => name.includes(w))) scores[cat] = (scores[cat] || 0) + p.probability;
    }
  }
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  return {
    category: best ? best[0] : null,
    confidence: best ? Math.min(best[1], 1) : 0,
    predictions: preds.slice(0, 3).map(p => ({ label: p.className.split(",")[0], p: p.probability })),
    source: "generic"
  };
}

/** Analyze an <img>/<canvas>. Returns { embedding, category, confidence, predictions, source }. */
export async function analyze(img) {
  await loadModels();
  const embedding = await embed(img);
  const cls = customModel ? await classifyCustom(img) : await classifyGeneric(img);
  if (cls.confidence < SETTINGS.MIN_AI_CONFIDENCE) cls.category = null;
  return { embedding, ...cls };
}

const TEMPLATES = {
  garbage:     "Garbage and litter have piled up at this spot. It is attracting pests, smells bad and is blocking the way for people nearby. Please arrange cleaning and regular collection.",
  pothole:     "There is a pothole in the road surface here. It is a hazard for two-wheelers, pedestrians and vehicles, especially at night and in the rain. Please repair it.",
  road:        "The road surface is damaged here, with cracks or broken patches that make travel unsafe and uncomfortable. Please inspect and resurface it.",
  streetlight: "The streetlight at this location is not working, leaving the area dark after sunset and unsafe for residents. Please repair or replace it.",
  drainage:    "The drain here is blocked or overflowing, causing dirty water to collect on the road. This is a health and mobility risk. Please clear the blockage.",
  water:       "Water is leaking from a pipe or tap at this location and is being wasted. Please send a team to repair it.",
  other:       ""
};

export function draftDescription(category, ai, place) {
  const base = TEMPLATES[category] ?? "";
  const cues = ai?.predictions?.length && ai.source === "generic"
    ? ` (Visual cues in the photo: ${ai.predictions.map(p => p.label).join(", ")}.)` : "";
  const where = place ? ` Location: ${place}.` : "";
  return (base + where + cues).trim();
}

/**
 * Compares before/after analyses. Heuristic only – an admin must confirm the result.
 * @returns {{similarity:number, score:number, verdict:'appears_resolved'|'uncertain'|'likely_not_resolved', reasons:string[]}}
 */
export function verifyResolution(before, after, category) {
  const sim = cosine(before, after.embedding);
  const reasons = [];
  let score;
  if (sim < SETTINGS.RESOLVED_SIM_MAX) { score = 0.6; reasons.push(`The scene looks clearly different from the original photo (similarity ${(sim * 100).toFixed(0)}%).`); }
  else { score = 0.15; reasons.push(`The photo looks very similar to the original (similarity ${(sim * 100).toFixed(0)}%), so little may have changed.`); }

  if (after.source === "custom") {
    const still = after.category === category && after.confidence >= 0.5;
    score += still ? -0.4 : 0.3;
    reasons.push(still
      ? "The trained model still detects the original issue type in the new photo."
      : "The trained model no longer detects the original issue in the new photo.");
  } else {
    reasons.push("No custom model is deployed, so only image similarity was used.");
  }
  score = Math.max(0, Math.min(1, score));
  const verdict = score >= 0.6 ? "appears_resolved" : score >= 0.35 ? "uncertain" : "likely_not_resolved";
  return { similarity: Math.round(sim * 1000) / 1000, score: Math.round(score * 100) / 100, verdict, reasons };
}

export const VERDICT_LABEL = {
  appears_resolved: "Appears resolved",
  uncertain: "Uncertain – review needed",
  likely_not_resolved: "Likely not resolved"
};

export const catById = id => CATEGORIES.find(c => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
