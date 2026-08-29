/**
 * server.js
 * ------------------------------------------------------------
 * Entry point backend Rizz Studio. Deploy ini SECARA TERPISAH
 * dari repo GitHub Pages (index.html) — GitHub Pages tidak bisa
 * menjalankan server Node.js.
 *
 * Hosting yang cocok: Render, Railway, Fly.io, atau VPS biasa.
 * TIDAK cocok: GitHub Pages, Netlify/Vercel static hosting.
 * ------------------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const mediaImportRouter = require('./mediaImport.routes');

const app = express();

// Domain frontend yang boleh manggil backend ini (isi via env var di Render/Railway)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'https://rizzstudio.my.id';

app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));
app.use(express.json());

// Serve hasil convert mp3 supaya bisa didownload dari frontend
app.use('/downloads', express.static(path.join(__dirname, 'public', 'downloads')));

// Semua endpoint fitur import/convert YouTube-TikTok
app.use(mediaImportRouter);

// Health check sederhana (buka URL backend langsung di browser buat cek server hidup atau tidak)
app.get('/', (req, res) => {
  res.send('Rizz Studio backend jalan ✅');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server jalan di port ${PORT}`);
  console.log(`Mengizinkan request dari origin: ${FRONTEND_ORIGIN}`);
});
