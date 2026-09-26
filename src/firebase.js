/**
 * Firebase init — single shared app/Firestore instance.
 * ------------------------------------------------------------------
 * Config values below (apiKey, projectId, etc.) are NOT secret — they're
 * meant to be embedded in the public JS bundle for any Firebase web app.
 * What actually protects the data is Firestore's security rules
 * (see firestore.rules) plus, if you turn it on, Firebase Auth.
 * ------------------------------------------------------------------
 */
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: 'AIzaSyBc16HlZrbOBYGiHHLKI-8-OO5ZAZnVrfc',
  authDomain: 'room-assingment.firebaseapp.com',
  projectId: 'room-assingment',
  storageBucket: 'room-assingment.firebasestorage.app',
  messagingSenderId: '265837277896',
  appId: '1:265837277896:web:bfc8dd2d2e5aaaa3936bfd',
  measurementId: 'G-8Z6QVJQ5QZ'
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
