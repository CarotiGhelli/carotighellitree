// Configurazione Firebase — Caroti Ghelli Tree
// Le chiavi API Firebase non sono segrete: la sicurezza è nelle Firestore Rules.

const firebaseConfig = {
  apiKey:            "AIzaSyDr2jWujo1-uV6ws2HY9TKmPc5cXQJRkJg",
  authDomain:        "carotighellitree.firebaseapp.com",
  projectId:         "carotighellitree",
  storageBucket:     "carotighellitree.firebasestorage.app",
  messagingSenderId: "28117552982",
  appId:             "1:28117552982:web:71ef81c1959edb329750f7"
};

firebase.initializeApp(firebaseConfig);
window.db             = firebase.firestore();
window.auth           = firebase.auth();
window.googleProvider = new firebase.auth.GoogleAuthProvider();
window.googleProvider.setCustomParameters({ prompt: "select_account" });
