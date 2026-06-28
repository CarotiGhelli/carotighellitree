// Configurazione Firebase — Caroti Ghelli Tree
const firebaseConfig = {
  apiKey:            "AIzaSyDr2jWujo1-uV6ws2HY9TKmPc5cXQJRkJg",
  authDomain:        "carotighellitree.firebaseapp.com",
  projectId:         "carotighellitree",
  storageBucket:     "carotighellitree.firebasestorage.app",
  messagingSenderId: "28117552982",
  appId:             "1:28117552982:web:71ef81c1959edb329750f7"
};

firebase.initializeApp(firebaseConfig);
window.db = firebase.firestore();
