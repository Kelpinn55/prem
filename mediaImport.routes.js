/**
 * mediaImport.routes.js
 * ------------------------------------------------------------
 * Router untuk fitur "Import via YouTube/TikTok" di Rizz Studio.
 * Menyediakan 2 endpoint yang dipanggil oleh frontend (index.html):
 *
 *   POST /api/media/resolve   -> ambil info video (judul, thumbnail, durasi)
 *   POST /proses-audio-url    -> download + convert audio dari link jadi MP3
 *
 * DEPENDENCY:
 *   npm install express fluent-ffmpeg ffmpeg-static
 *   + binary "yt-dlp" harus terpasang di server (lihat catatan di bawah file ini)
 *
 * CARA PAKAI di server.js utama:
 *   const mediaImportRouter = require('./mediaImport.routes');
 *   app.use(express.json());
 *   app.use('/downloads', express.static(path.join(__dirname, 'public', 'downloads')));
 *   app.use(mediaImportRouter);
 * ------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStaticPath = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStaticPath);

const router = express.Router();

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  // Kalau yt-dlp tidak ada di PATH server, isi path lengkap binary-nya di sini
  // (atau set environment variable YT_DLP_PATH)
  YT_DLP_BIN: process.env.YT_DLP_PATH || 'yt-dlp',
  TMP_DIR: path.join(__dirname, 'tmp'),
  OUTPUT_DIR: path.join(__dirname, 'public', 'downloads'),
  MAX_BUFFER: 1024 * 1024 * 50, // 50MB, buat handle output yt-dlp yang besar
};

// Domain yang diizinkan — mencegah endpoint ini disalahgunakan jadi proxy/SSRF ke URL sembarangan
const ALLOWED_HOSTS = [
  'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
  'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
];

fs.mkdirSync(CONFIG.TMP_DIR, { recursive: true });
fs.mkdirSync(CONFIG.OUTPUT_DIR, { recursive: true });

// ── HELPER ──────────────────────────────────────────────────
function isAllowedUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return ALLOWED_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}

function formatTime(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function sanitizeFilename(name) {
  return (name || 'sonora_output').replace(/[^a-z0-9_\- ]/gi, '_').slice(0, 80);
}

// Ambil metadata video via `yt-dlp -j <url>`
function runYtDlpJson(url) {
  return new Promise((resolve, reject) => {
    execFile(
      CONFIG.YT_DLP_BIN,
      ['-j', '--no-warnings', '--no-check-certificate', url],
      { maxBuffer: CONFIG.MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error('Gagal membaca metadata dari yt-dlp.'));
        }
      }
    );
  });
}

// Download + extract audio jadi mp3 mentah via yt-dlp
function downloadAudio(url, outPathNoExt) {
  return new Promise((resolve, reject) => {
    execFile(
      CONFIG.YT_DLP_BIN,
      [
        '-x', '--audio-format', 'mp3',
        '--no-check-certificate', '--no-warnings',
        '-o', `${outPathNoExt}.%(ext)s`,
        url,
      ],
      { maxBuffer: CONFIG.MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
  });
}

function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration);
    });
  });
}

// Susun filter ffmpeg dari parameter speed & amplify yang dikirim frontend
function buildAudioFilters(speedRaw, amplifyRaw) {
  const filters = [];

  // atempo hanya valid di rentang 0.5–2.0, jadi di-chain kalau di luar itu
  let tempo = parseFloat(speedRaw) || 1;
  while (tempo > 2.0) { filters.push('atempo=2.0'); tempo /= 2.0; }
  while (tempo < 0.5) { filters.push('atempo=0.5'); tempo /= 0.5; }
  if (Math.abs(tempo - 1) > 0.001) filters.push(`atempo=${tempo.toFixed(3)}`);

  const vol = parseFloat(amplifyRaw) || 1;
  if (Math.abs(vol - 1) > 0.001) filters.push(`volume=${vol}`);

  return filters.length ? filters : ['anull'];
}

// ── ENDPOINT 1: resolve info media ────────────────────────────
router.post('/api/media/resolve', async (req, res) => {
  const { url, platform } = req.body || {};

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL tidak boleh kosong.' });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, error: 'Link harus dari YouTube atau TikTok.' });
  }

  try {
    const info = await runYtDlpJson(url);
    res.json({
      success: true,
      platform: platform || 'unknown',
      downloadUrl: url, // simpan URL original, BUKAN direct CDN link (cepat expired/kena 403)
      title: info.title || 'Media',
      author: info.uploader || info.channel || '',
      thumbnail: info.thumbnail || '',
      durationFormatted: formatTime(info.duration),
    });
  } catch (err) {
    console.error('[media/resolve]', err.message);
    res.status(500).json({
      success: false,
      error: 'Gagal mengambil info dari link ini. Pastikan link valid, publik, dan tidak diprivat/age-restricted.',
    });
  }
});

// ── ENDPOINT 2: proses/convert audio dari link ────────────────
router.post('/proses-audio-url', async (req, res) => {
  const { url, speed, amplify, maxDuration, title } = req.body || {};

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL tidak valid.' });
  }
  if (!isAllowedUrl(url)) {
    return res.status(400).json({ success: false, error: 'Link harus dari YouTube atau TikTok.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const rawNoExt = path.join(CONFIG.TMP_DIR, `${jobId}_raw`);
  const rawPath = `${rawNoExt}.mp3`;
  const outName = `${jobId}.mp3`;
  const outPath = path.join(CONFIG.OUTPUT_DIR, outName);

  try {
    // 1) Download & extract audio dari YouTube/TikTok
    await downloadAudio(url, rawNoExt);

    // 2) Proses dengan ffmpeg: atur speed, amplify, potong durasi kalau perlu
    const filters = buildAudioFilters(speed, amplify);
    const maxDur = parseInt(maxDuration, 10);

    await new Promise((resolve, reject) => {
      let cmd = ffmpeg(rawPath).audioFilters(filters);
      if (maxDur > 0) cmd = cmd.duration(maxDur);
      cmd.format('mp3').on('error', reject).on('end', resolve).save(outPath);
    });

    const stat = fs.statSync(outPath);
    const durationSec = await getAudioDuration(outPath);

    fs.unlink(rawPath, () => {}); // bersihkan file mentah

    res.json({
      success: true,
      durationFormatted: formatTime(durationSec),
      fileSize: formatBytes(stat.size),
      speed: speed || '1',
      downloadLink: `/downloads/${outName}`, // digabung frontend jadi `${API_BASE_URL}${downloadLink}`
      outputFile: `${sanitizeFilename(title)}.mp3`,
    });
  } catch (err) {
    console.error('[proses-audio-url]', err.message);
    if (fs.existsSync(rawPath)) fs.unlink(rawPath, () => {});
    res.status(500).json({
      success: false,
      error: 'Gagal memproses audio dari link ini: ' + err.message,
    });
  }
});

module.exports = router;

/**
 * ── CATATAN INSTALASI yt-dlp DI SERVER ────────────────────────
 * yt-dlp BUKAN package npm, jadi harus dipasang terpisah di server:
 *
 *   # Linux/VPS (paling gampang, via pip):
 *   pip install -U yt-dlp
 *
 *   # atau download binary langsung:
 *   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
 *   sudo chmod a+rx /usr/local/bin/yt-dlp
 *
 * ffmpeg untuk proses audio-nya sudah otomatis ke-install lewat
 * package npm "ffmpeg-static" — tidak perlu install manual.
 *
 * PENTING soal hosting:
 * - Platform serverless (Vercel/Netlify Functions) biasanya TIDAK cocok
 *   karena filesystem read-only & proses spawn binary dibatasi.
 *   Pakai VPS/Docker/Railway/Render (server long-running biasa).
 * - Update yt-dlp berkala ("yt-dlp -U" atau reinstall pip) karena
 *   YouTube/TikTok sering ubah struktur internal mereka.
 */
