// server.js
import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

/* =========================================================
   HELPERS (UNCHANGED)
========================================================= */

function clean(text = "") {
  return text.replace(/```json|```/g, "").trim();
}

function safeJsonParse(text) {
  try { return JSON.parse(text); }
  catch { return null; }
}

async function callGemini(prompt) {
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 }
      })
    }
  );
  const j = await r.json();
  return j;
}

/* =========================================================
   🔵 YOUTUBE — LEFT EXACTLY AS IT WAS
========================================================= */

const SYSTEM_PROMPT = `You are an Intent Extraction Engine.
Return ONLY valid JSON with intent, topic, language, complexity, format`;

const YOUTUBE_QUERY_PROMPT = `Generate ONE YouTube search query string only.`;

async function fetchYouTubeVideos(query, duration, maxResults = 10) {
  const url =
    `https://www.googleapis.com/youtube/v3/search` +
    `?part=snippet&type=video&maxResults=${maxResults}` +
    `&videoDuration=${duration}` +
    `&q=${encodeURIComponent(query)}` +
    `&key=${YOUTUBE_API_KEY}`;

  const r = await fetch(url);
  const j = await r.json();

  return (j.items || []).map(v => ({
    videoId: v.id.videoId,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    thumbnail: v.snippet.thumbnails.medium.url
  }));
}

app.post("/extract-intent", async (req, res) => {
  try {
    const userInput = req.body.text;
    if (!userInput) return res.status(400).json({ error: "No text" });

    const intentRaw = await callGemini(
      `${SYSTEM_PROMPT}\nUser query: "${userInput}"`
    );

    let intent = { topic: userInput };

    const intentText =
      intentRaw?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (intentText) {
      const parsed = safeJsonParse(clean(intentText));
      if (parsed) intent = parsed;
    }

    let ytQuery = userInput;

    const queryRaw = await callGemini(
      `${YOUTUBE_QUERY_PROMPT}\n${JSON.stringify(intent)}`
    );

    const queryText =
      queryRaw?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (queryText) ytQuery = clean(queryText);

    const shorts = await fetchYouTubeVideos(ytQuery, "short", 10);
    const long = await fetchYouTubeVideos(ytQuery, "long", 10);

    res.json({
      intent,
      youtubeQuery: ytQuery,
      shorts: shorts.slice(0, 5),
      long: long.slice(0, 5)
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "YT pipeline failed" });
  }
});

/* =========================================================
   🟠 REDDIT — APPENDED (DOES NOT TOUCH YT)
========================================================= */

const USER_AGENT = "intent-demo/1.0";

async function fetchReddit(query, sort) {
  const url =
    `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}` +
    `&sort=${sort}&limit=10`;

  const r = await fetch(url, {
    headers: { "User-Agent": USER_AGENT }
  });

  const j = await r.json();

  return (j.data?.children || []).map(p => ({
    id: p.data.id,
    title: p.data.title,
    subreddit: p.data.subreddit,
    score: p.data.score,
    comments: p.data.num_comments,
    url: `https://reddit.com${p.data.permalink}`,
    selftext: p.data.selftext
  }));
}

app.post("/reddit-search", async (req, res) => {
  try {
    const text = req.body.text;
    if (!text) return res.status(400).json({ error: "No text" });

    const intentRaw = await callGemini(
      `${SYSTEM_PROMPT}\nUser query: "${text}"`
    );

    let intent = { topic: text };

    const intentText =
      intentRaw?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (intentText) {
      const parsed = safeJsonParse(clean(intentText));
      if (parsed) intent = parsed;
    }

    const query = [
      intent.topic,
      intent.language,
      intent.format
    ].filter(Boolean).join(" ");

    const hot = await fetchReddit(query, "relevance");
    const fresh = await fetchReddit(query, "new");
    const top = await fetchReddit(query, "top");

    res.json({
      intent,
      query,
      hot,
      new: fresh,
      top
    });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Reddit failed" });
  }
});

/* =========================================================
   START
========================================================= */

app.listen(3000, () =>
  console.log("🚀 Server running on http://localhost:3000")
);
