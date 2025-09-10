const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const app = express();

// Création du dossier uploads si inexistant
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// Configuration du stockage des fichiers
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage });

// Servir le frontend et les images
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Endpoint pour uploader les images
app.post('/upload', upload.array('images'), (req, res) => {
  const files = req.files.map(f => `/uploads/${f.filename}`);
  res.json(files); // renvoie les URLs des images
});

// Démarrer le serveur
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur démarré sur http://localhost:${PORT}`));
