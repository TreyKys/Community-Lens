// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions, httpsCallable } from "firebase/functions";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "community-lens-dd945.firebaseapp.com",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "community-lens-dd945",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "community-lens-dd945.firebasestorage.app",
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const functions = getFunctions(app);

// Helper to call onRequest functions acting as callables
const callFunction = async (name, data) => {
  const projectId = firebaseConfig.projectId;
  const url = `https://us-central1-${projectId}.cloudfunctions.net/${name}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ data }), // Wrap data to match httpsCallable expectations or backend logic
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Error ${response.status}: ${errorText}`);
  }

  return response.json(); // Backend returns { data: ... }
};

// Export wrappers that match the httpsCallable signature (returning a Promise that resolves to { data: ... })
export const fetchGrokSource = (data) => callFunction('fetchGrokSource', data);
export const fetchConsensus = (data) => callFunction('fetchConsensus', data);
export const analyzeDiscrepancy = (data) => callFunction('analyzeDiscrepancy', data);
export const mintCommunityNote = (data) => callFunction('mintCommunityNote', data);
export const agentGuard = (data) => callFunction('agentGuard', data);

export { db };
