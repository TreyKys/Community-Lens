// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyAjwMgCU2tXhTMkrjLxdXg7wNoZ1fWdPQs",
  authDomain: "community-lens-dd945.firebaseapp.com",
  projectId: "community-lens-dd945",
  storageBucket: "community-lens-dd945.firebasestorage.app",
  messagingSenderId: "602234027628",
  appId: "1:602234027628:web:8d7be7ee934881cb71a249"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// Helper to call local backend functions
const callFunction = async (name, data) => {
  // Get the backend domain from environment or use default
  const domain = process.env.REACT_APP_API_URL || `${window.location.protocol}//${window.location.hostname}:3000`;
  const url = `${domain}/${name}`;

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
export const createBounty = (data) => callFunction('api/createBounty', data);
export const fetchGrokSource = (data) => callFunction('api/fetchGrokSource', data);
export const fetchConsensus = (data) => callFunction('api/fetchConsensus', data);
export const analyzeDiscrepancy = (data) => callFunction('api/analyzeDiscrepancy', data);
export const mintCommunityNote = (data) => callFunction('api/mintCommunityNote', data);
export const agentGuard = (data) => callFunction('api/agentGuard', data);

export { db };
