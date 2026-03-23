import * as admin from 'firebase-admin';

if (!admin.apps.length) {
    try {
        // Use default credentials if running in a cloud environment (e.g. Netlify/Vercel)
        // or explicitly check if the env vars actually exist before calling cert()
        if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
            admin.initializeApp({
                credential: admin.credential.cert({
                    projectId: process.env.FIREBASE_PROJECT_ID,
                    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                    // Replace escaped newlines
                    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
                }),
            });
            console.log('Firebase Admin initialized with cert.');
        } else {
             // Mock fallback so the build doesn't crash if env vars are missing during the build phase
             admin.initializeApp({ projectId: "mock-project-for-build" });
             console.log('Firebase Admin mock initialized for build.');
        }
    } catch (error) {
        console.error('Firebase Admin initialization error', error);
    }
}

export const db = admin.firestore();
