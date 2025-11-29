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

// Helper to call backend functions
const callFunction = async (name, data) => {
  // Use public Replit backend domain for production (Netlify) and development
  const backendDomain = 'https://2192a4ea-d452-48bf-b57d-69c6eafeba86-00-1cm2falbtp98y.kirk.replit.dev';
  const url = `${backendDomain}/${name}`;

  console.log('API Call:', { url, data });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ data }), // Wrap data to match httpsCallable expectations or backend logic
    });

    console.log('API Response Status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('API Error Response:', errorText);
      throw new Error(`Error ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    console.log('API Success:', result);
    return result; // Backend returns { data: ... }
  } catch (error) {
    console.error('API Fetch Error:', error.message);
    throw error;
  }
};

// Export wrappers that match the httpsCallable signature (returning a Promise that resolves to { data: ... })
export const createBounty = (data) => callFunction('api/createBounty', data);
export const fetchGrokSource = (data) => callFunction('api/fetchGrokSource', data);
export const fetchConsensus = (data) => callFunction('api/fetchConsensus', data);
export const analyzeDiscrepancy = (data) => callFunction('api/analyzeDiscrepancy', data);
export const mintCommunityNote = (data) => callFunction('api/mintCommunityNote', data);
export const agentGuard = (data) => callFunction('api/agentGuard', data);

// Get bounties from backend
export const getBounties = async () => {
  const backendDomain = 'https://2192a4ea-d452-48bf-b57d-69c6eafeba86-00-1cm2falbtp98y.kirk.replit.dev';
  const url = `${backendDomain}/api/getBounties`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Error ${response.status}`);
    }
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error fetching bounties:', error);
    return { data: [] };
  }
};

export { db };
