// ⚠️  COMPILA QUESTO FILE con i valori del tuo progetto Firebase
//     (segui le istruzioni nel README — Passaggio A)
//     Puoi lasciare questo file nel repository pubblico: le API key Firebase
//     non sono segrete, la sicurezza è gestita dalle Firestore Rules.

const firebaseConfig = {
  apiKey:            "INSERISCI_API_KEY",
  authDomain:        "INSERISCI_AUTH_DOMAIN",
  projectId:         "INSERISCI_PROJECT_ID",
  storageBucket:     "INSERISCI_STORAGE_BUCKET",
  messagingSenderId: "INSERISCI_MESSAGING_SENDER_ID",
  appId:             "INSERISCI_APP_ID"
};

firebase.initializeApp(firebaseConfig);
window.db             = firebase.firestore();
window.auth           = firebase.auth();
window.googleProvider = new firebase.auth.GoogleAuthProvider();
window.googleProvider.setCustomParameters({ prompt: "select_account" });
