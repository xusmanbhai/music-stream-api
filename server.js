const express = require("express");
const cors = require("cors");
const play = require("play-dl");
const ytDlp = require("yt-dlp-exec");
const https = require("https");
const http = require("http");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── Helper: format duration (seconds → mm:ss) ────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// ─── GET /search?song=<name> ──────────────────────────────────────────────────
// Returns top 5 YouTube results as JSON
app.get("/search", async (req, res) => {
  const { song } = req.query;

  if (!song || song.trim() === "") {
    return res.status(400).json({ error: "Query parameter 'song' is required." });
  }

  try {
    const results = await play.search(song.trim(), {
      source: { youtube: "video" },
      limit: 5,
    });

    const tracks = results.map((video) => ({
      id: video.id,
      title: video.title,
      duration: formatDuration(video.durationInSec),
      durationSeconds: video.durationInSec,
      thumbnail:
        video.thumbnails?.[0]?.url ||
        `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
      url: video.url,
      channel: video.channel?.name || "Unknown",
      views: video.views,
    }));

    res.json({ success: true, query: song, results: tracks });
  } catch (err) {
    console.error("[/search] Error:", err.message);
    res.status(500).json({ error: "Failed to search YouTube.", detail: err.message });
  }
});

// ─── POST /search ─────────────────────────────────────────────────────────────
// Same as GET but accepts { song } in body (handy for mobile apps)
app.post("/search", async (req, res) => {
  const song = req.body?.song || req.query?.song;

  if (!song || song.trim() === "") {
    return res.status(400).json({ error: "Field 'song' is required in body or query." });
  }

  try {
    const results = await play.search(song.trim(), {
      source: { youtube: "video" },
      limit: 5,
    });

    const tracks = results.map((video) => ({
      id: video.id,
      title: video.title,
      duration: formatDuration(video.durationInSec),
      durationSeconds: video.durationInSec,
      thumbnail:
        video.thumbnails?.[0]?.url ||
        `https://img.youtube.com/vi/${video.id}/hqdefault.jpg`,
      url: video.url,
      channel: video.channel?.name || "Unknown",
      views: video.views,
    }));

    res.json({ success: true, query: song, results: tracks });
  } catch (err) {
    console.error("[POST /search] Error:", err.message);
    res.status(500).json({ error: "Failed to search YouTube.", detail: err.message });
  }
});

// ─── Stream URL cache (video id → { url, expiresAt }) ──────────────────────────
// YouTube signed URLs are valid ~6 hours; we cache for 5 to be safe.
const CACHE_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours
const streamUrlCache = new Map();

function getCachedUrl(videoId) {
  const entry = streamUrlCache.get(videoId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { streamUrlCache.delete(videoId); return null; }
  return entry.url;
}

function setCachedUrl(videoId, url) {
  streamUrlCache.set(videoId, { url, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── GET /play?url=<youtube_url> ─────────────────────────────────────────────
// Extracts a direct audio URL via yt-dlp and proxies it to the client.
// play-dl can no longer decrypt YouTube stream URLs (signature changes);
// yt-dlp is actively maintained and handles this reliably.
app.get("/play", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Query parameter 'url' is required." });
  }

  // Validate it's a YouTube URL
  const ytValidate = play.yt_validate(url);
  if (ytValidate !== "video") {
    return res.status(400).json({ error: "Invalid or unsupported YouTube URL." });
  }

  try {
    // Extract video ID for cache keying
    const videoId = new URL(url).searchParams.get("v") || url;

    // 1. Check cache first — skip yt-dlp entirely on repeat plays
    let streamUrl = getCachedUrl(videoId);

    if (streamUrl) {
      console.log(`[/play] Cache HIT for ${videoId}`);
    } else {
      console.log(`[/play] Cache MISS for ${videoId} — calling yt-dlp`);
      const start = Date.now();

      // --get-url is much faster than --dump-single-json:
      // it only extracts and prints the stream URL, no full metadata fetch.
      const rawUrl = await ytDlp(url, {
        getUrl: true,
        noWarnings: true,
        noCallHome: true,
        preferFreeFormats: true,
        youtubeSkipDashManifest: true,
        format: "bestaudio[ext=webm]/bestaudio/best",
      });

      // yt-dlp --get-url can return multiple lines; take the first non-empty one
      streamUrl = (typeof rawUrl === "string" ? rawUrl : String(rawUrl))
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("http"));

      console.log(`[/play] yt-dlp took ${Date.now() - start}ms`);

      if (!streamUrl) {
        return res.status(500).json({ error: "Could not extract a playable audio URL." });
      }

      // Store in cache for future requests
      setCachedUrl(videoId, streamUrl);
    }

    // Proxy the direct stream URL to the client
    const proto = streamUrl.startsWith("https") ? https : http;
    const proxyReq = proto.get(streamUrl, (proxyRes) => {
      // Forward relevant headers
      const contentType = proxyRes.headers["content-type"] || "audio/webm";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (proxyRes.headers["content-length"]) {
        res.setHeader("Content-Length", proxyRes.headers["content-length"]);
      }
      res.setHeader("Accept-Ranges", "bytes");

      res.writeHead(proxyRes.statusCode || 200);
      proxyRes.pipe(res);

      proxyRes.on("error", (err) => {
        console.error("[/play] Proxy response error:", err.message);
        if (!res.headersSent) res.status(500).end();
      });
    });

    proxyReq.on("error", (err) => {
      console.error("[/play] Proxy request error:", err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to proxy audio stream.", detail: err.message });
      }
    });

    // Handle client disconnect — abort the upstream request
    req.on("close", () => proxyReq.destroy());

  } catch (err) {
    console.error("[/play] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to stream audio.", detail: err.message });
    }
  }
});

// ─── GET /info?url=<youtube_url> ─────────────────────────────────────────────
// Returns full metadata for a single video — useful for mobile app detail screens
app.get("/info", async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Query parameter 'url' is required." });
  }

  try {
    const info = await play.video_info(url);
    const details = info.video_details;

    res.json({
      success: true,
      id: details.id,
      title: details.title,
      description: details.description?.slice(0, 500),
      duration: formatDuration(details.durationInSec),
      durationSeconds: details.durationInSec,
      thumbnail: details.thumbnails?.[0]?.url,
      url: details.url,
      channel: details.channel?.name,
      views: details.views,
      likes: details.likes,
      uploadedAt: details.uploadedAt,
    });
  } catch (err) {
    console.error("[/info] Error:", err.message);
    res.status(500).json({ error: "Failed to get video info.", detail: err.message });
  }
});

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    endpoints: [
      "GET  /search?song=<name>    → top 5 YouTube results",
      "POST /search                → same, body: { song }",
      "GET  /play?url=<yt_url>    → audio stream (audio/webm)",
      "GET  /info?url=<yt_url>    → video metadata JSON",
      "GET  /health               → this status page",
    ],
  });
});

// ─── Root redirect to public/index.html ───────────────────────────────────────
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎵  Music Stream API running on http://localhost:${PORT}`);
  console.log(`📡  Endpoints:`);
  console.log(`    GET  /search?song=<name>`);
  console.log(`    POST /search   (body: { "song": "..." })`);
  console.log(`    GET  /play?url=<youtube_url>`);
  console.log(`    GET  /info?url=<youtube_url>`);
  console.log(`    GET  /health\n`);
});
