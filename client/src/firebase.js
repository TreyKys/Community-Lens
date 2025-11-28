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

// Helper to call onRequest functions acting as callables
const callFunction = async (name, data) => {
  const projectId = firebaseConfig.projectId;
  // Construct the URL dynamically based on the Project ID.
  // Matches: https://us-central1-community-lens-dd945.cloudfunctions.net/<functionName>
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
export const createBounty = (data) => callFunction('createBounty', data);
export const fetchGrokSource = (data) => callFunction('fetchGrokSource', data);
export const fetchConsensus = (data) => callFunction('fetchConsensus', data);
export const analyzeDiscrepancy = (data) => callFunction('analyzeDiscrepancy', data);
export const mintCommunityNote = (data) => callFunction('mintCommunityNote', data);
export const agentGuard = (data) => callFunction('agentGuard', data);

export { db };
