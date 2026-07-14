import { getApp, getApps, initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFirebaseWebConfig } from "./config";

export function getFirebaseApp() {
  return getApps().length ? getApp() : initializeApp(getFirebaseWebConfig());
}

export function getClientFirestore() {
  return getFirestore(getFirebaseApp());
}
