import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, sendPasswordResetEmail, updateProfile
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc, query, where,
  orderBy, limit, serverTimestamp, Timestamp, arrayUnion
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";
import { firebaseConfig, SETTINGS } from "./config.js";

export const configured = !firebaseConfig.apiKey.startsWith("YOUR_");
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
const storage = getStorage(app);

export {
  onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, updateProfile, collection, doc, getDoc, getDocs, addDoc, setDoc, updateDoc,
  query, where, orderBy, limit, serverTimestamp, Timestamp, arrayUnion
};

const blobToDataURL = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

/** Stores an image blob and returns a URL (Storage URL, or a data: URL when USE_STORAGE is false). */
export async function saveImage(blob, path) {
  if (!SETTINGS.USE_STORAGE) return blobToDataURL(blob);
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: blob.type || "image/jpeg" });
  return getDownloadURL(r);
}
