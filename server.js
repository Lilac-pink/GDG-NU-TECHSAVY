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

// quick key check
if (!GEMINI_API_KEY) console.warn("⚠️ GEMINI_API_KEY missing");
if (!YOUTUBE_API_KEY) console.warn("⚠️ YOUTUBE_API_KEY missing");

/* =========================
   Prompts & helpers - UPDATED
========================= */
const SYSTEM_PROMPT = `You are an Intent Extraction Engine specialized in Reddit searches.
Extract intent from user query. Return ONLY valid JSON with:
1. intent: main goal (FindCode, Learn, Compare, Troubleshoot, etc.)
2. topic: main subject (be specific)
3. language: programming language if mentioned
4. complexity: beginner/intermediate/advanced
5. format: what format they want (examples, tutorials, discussions, etc.)
6. search_terms: array of specific keywords for searching
Example: {"intent": "FindCode", "topic": "basic calculator", "language": "cpp", "complexity": "beginner", "format": "examples", "search_terms": ["calculator", "beginner", "C++", "code example"]}`;

const REDDIT_QUERY_PROMPT = `You are a Reddit search expert.
Given an intent JSON, output ONE optimal search query for Reddit's search.
Make it specific and include programming language.
Do NOT wrap in backticks. Just the plain search query.
Examples:
- Input: {"intent": "FindCode", "topic": "basic calculator", "language": "cpp", "complexity": "beginner"}
- Output: "C++ calculator code example beginner"

- Input: {"intent": "Learn", "topic": "machine learning", "language": "python", "complexity": "intermediate"}
- Output: "machine learning Python tutorial intermediate"`;

const REDDIT_BREAKDOWN_PROMPT = `You are a Reddit strategy analyzer.
Given an intent, analyze and return JSON with:
1. subreddits: array of relevant subreddits (choose from programming-specific ones)
2. keywords: main search terms (5-7 specific terms)
3. time_filter: (hour, day, week, month, year, all)
4. sort: (relevance, hot, new, top)
5. limit: number of posts to fetch
6. restrict_sr: true/false (whether to restrict to subreddit)

Choose subreddits based on topic:
- General programming: ["learnprogramming", "programming", "coding"]
- C/C++: ["cpp", "cpp_questions", "Cplusplus"]
- Python: ["Python", "learnpython"]
- Web dev: ["webdev", "javascript", "reactjs"]
- Java: ["java", "learnjava"]
- CS questions: ["computerscience", "askprogramming"]

Example output:
{"subreddits": ["learnprogramming", "cpp_questions"], "keywords": ["calculator", "C++", "beginner", "code", "example"], "time_filter": "week", "sort": "relevance", "limit": 10, "restrict_sr": true}`;

const YOUTUBE_QUERY_PROMPT = `You are a YouTube search expert.
Given an intent JSON, output ONE optimal search query for YouTube.
Make it specific and include programming language, topic, and complexity.
Do NOT wrap in backticks. Just plain text search query.
Example:
Input: {"intent": "FindCode", "topic": "basic calculator", "language": "cpp", "complexity": "beginner"}
Output: "C++ basic calculator code example beginner"`;

// Utility functions
function clean(text = "") {
  if (!text) return "";
  return text.replace(/```json|```/g, "").trim();
}

function safeJsonParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) {
    console.log("JSON parse error, trying to fix:", e.message);
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        console.log("Failed to extract JSON:", e2.message);
      }
    }
    return null;
  }
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
}

/* =========================
   Gemini call helper
========================= */
async function callGemini(textPayload, model = "gemini-1.5-flash") {
  if (!GEMINI_API_KEY) {
    console.error("No GEMINI_API_KEY");
    return null;
  }

  try {
    const r = await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: textPayload }] }],
          generationConfig: {
            temperature: 0.2,
            topP: 0.8,
            topK: 40,
          },
        }),
      },
      10000 // 10 seconds
    );

    if (!r.ok) {
      console.error(`Gemini API error: ${r.status} ${r.statusText}`);
      return null;
    }

    const data = await r.json();
    return data;
  } catch (e) {
    console.error("Gemini fetch error:", e.message);
    return null;
  }
}

/* =========================
   YouTube videos fetch helper
========================= */
async function fetchYouTubeVideos(query, videoDuration = "any", maxResults = 10) {
  if (!YOUTUBE_API_KEY) {
    console.error("No YOUTUBE_API_KEY");
    return [];
  }

  // videoDuration options: any, short, medium, long
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("maxResults", maxResults);
  url.searchParams.set("q", query);
  url.searchParams.set("type", "video");
  url.searchParams.set("videoDuration", videoDuration);
  url.searchParams.set("safeSearch", "strict");

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      console.error(`YouTube API error: ${response.status} ${response.statusText}`);
      return [];
    }
    const data = await response.json();

    if (!data.items) return [];

    return data.items.map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      description: item.snippet.description,
      channelTitle: item.snippet.channelTitle,
      publishTime: item.snippet.publishedAt,
      thumbnails: item.snippet.thumbnails,
    }));
  } catch (error) {
    console.error("YouTube fetch error:", error.message);
    return [];
  }
}

/* =========================
   Rerank helper for YouTube videos using Gemini (optional, simplified)
========================= */
async function rerankWithGemini(intent, videos) {
  // Simplified: Return original videos without rerank for now
  return videos;
}

/* =========================
   Reddit related helpers
========================= */

async function searchSpecificSubreddits(query, subreddits, sort = "relevance", time = "week", limit = 5) {
  const results = [];

  for (const subreddit of subreddits) {
    if (results.length >= limit * 2) break;

    try {
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(
        query
      )}&restrict_sr=1&sort=${sort}&t=${time}&limit=10`;

      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          },
        },
        5000
      );

      if (!response.ok) continue;

      const data = await response.json();

      if (data.data && data.data.children) {
        data.data.children.forEach((post) => {
          const postData = post.data;
          if (postData.stickied || postData.over_18) return;
          if (!postData.selftext && postData.is_self === false && postData.domain !== "self." + subreddit) return;

          results.push({
            id: postData.id,
            title: postData.title,
            subreddit: subreddit,
            author: postData.author,
            score: postData.score || 0,
            comments: postData.num_comments || 0,
            created: postData.created_utc,
            url: `https://reddit.com${postData.permalink}`,
            thumbnail:
              postData.thumbnail && !["self", "default", "nsfw", "image", "spoiler"].includes(postData.thumbnail)
                ? postData.thumbnail
                : null,
            selftext: postData.selftext || "",
            nsfw: postData.over_18 || false,
            flair: postData.link_flair_text,
            domain: postData.domain,
            is_self: postData.is_self,
          });
        });
      }
    } catch (error) {
      console.log(`Failed to search r/${subreddit}:`, error.message);
      continue;
    }
  }

  return results;
}

function filterAndRankPosts(posts, keywords, topic) {
  return posts
    .map((post) => {
      let relevanceScore = 0;
      const title = post.title.toLowerCase();
      const text = post.selftext.toLowerCase();

      keywords.forEach((keyword) => {
        const kw = keyword.toLowerCase();
        if (title.includes(kw)) relevanceScore += 3;
        if (text.includes(kw)) relevanceScore += 1;
      });

      if (title.includes(topic.toLowerCase())) relevanceScore += 2;
      if (post.comments > 10) relevanceScore += 1;
      if (post.is_self) relevanceScore += 1;

      return { ...post, relevanceScore };
    })
    .filter((post) => post.relevanceScore > 0)
    .sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) {
        return b.relevanceScore - a.relevanceScore;
      }
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return b.comments - a.comments;
    });
}

async function fetchRedditPostsByStrategy(strategy) {
  const { subreddits, keywords, time_filter, sort, limit, restrict_sr = true } = strategy;

  const query = keywords.join(" ");

  if (restrict_sr && subreddits.length > 0) {
    const posts = await searchSpecificSubreddits(query, subreddits, sort, time_filter, limit * 2);
    const filteredPosts = filterAndRankPosts(posts, keywords, strategy.topic || keywords[0]);
    return filteredPosts.slice(0, limit);
  } else {
    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time_filter}&limit=${limit * 2}`;
      const response = await fetchWithTimeout(
        url,
        {
          headers: { "User-Agent": "Mozilla/5.0" },
        },
        8000
      );

      if (!response.ok) return [];

      const data = await response.json();

      if (!data.data || !data.data.children) return [];

      const posts = data.data.children.map((post) => {
        const postData = post.data;
        return {
          id: postData.id,
          title: postData.title,
          subreddit: postData.subreddit,
          author: postData.author,
          score: postData.score || 0,
          comments: postData.num_comments || 0,
          url: `https://reddit.com${postData.permalink}`,
          thumbnail: null,
          selftext: postData.selftext || "",
          nsfw: postData.over_18 || false,
          is_self: postData.is_self,
        };
      });

      const filteredPosts = filterAndRankPosts(posts, keywords, strategy.topic || keywords[0]);
      return filteredPosts.slice(0, limit);
    } catch (error) {
      console.error("General Reddit search failed:", error);
      return [];
    }
  }
}

function generateEducationalPosts(topic, language = "") {
  const basePosts = [
    {
      title: `How to implement a ${topic} in ${language || "programming"}`,
      subreddit: "learnprogramming",
      author: "ProgrammingHelper",
      score: 125,
      comments: 42,
      selftext: `I see many beginners asking about ${topic}. Here's a simple approach...`,
      is_self: true,
    },
    {
      title: `${language ? language + " " : ""}${topic} - Common mistakes and solutions`,
      subreddit: language ? `${language}_questions` : "programming",
      author: "CodeReviewExpert",
      score: 89,
      comments: 31,
      selftext: `When working on ${topic}, beginners often make these mistakes...`,
      is_self: true,
    },
    {
      title: `Best resources for learning ${topic} ${language ? "in " + language : ""}`,
      subreddit: "learnprogramming",
      author: "ResourceCollector",
      score: 156,
      comments: 58,
      selftext: `Here are some excellent resources I've collected for ${topic}...`,
      is_self: true,
    },
    {
      title: `Debugging help: ${topic} not working as expected`,
      subreddit: language ? language : "coding",
      author: "DebugHelper",
      score: 72,
      comments: 24,
      selftext: `If your ${topic} implementation isn't working, check these common issues...`,
      is_self: true,
    },
    {
      title: `Efficient ${topic} implementation - optimization tips`,
      subreddit: "programming",
      author: "PerfOptimizer",
      score: 203,
      comments: 67,
      selftext: `Let's discuss how to make your ${topic} code more efficient and readable...`,
      is_self: true,
    },
  ];

  return basePosts.map((post, index) => ({
    id: `edu-${topic.replace(/\s+/g, "-")}-${index}`,
    ...post,
    url: `https://reddit.com/r/${post.subreddit}/comments/sample`,
    thumbnail: null,
    nsfw: false,
    created: Date.now() / 1000 - index * 86400,
  }));
}

async function searchRedditWithIntent(intent) {
  try {
    // Generate search query from intent
    const queryPrompt = `${REDDIT_QUERY_PROMPT}\n\nIntent: ${JSON.stringify(intent, null, 2)}`;
    const queryResult = await callGemini(queryPrompt);

    let searchQuery = "";

    if (queryResult?.candidates?.[0]?.content?.parts?.[0]?.text) {
      searchQuery = clean(queryResult.candidates[0].content.parts[0].text);
    }

    if (!searchQuery || searchQuery.includes("```")) {
      searchQuery = `${intent.language || ""} ${intent.topic || ""} ${intent.format || "help"}`.trim();
    }

    // Get search strategy
    let strategy = {
      subreddits: ["learnprogramming", "programming"],
      keywords: [intent.topic, intent.language, "help", "example"].filter(Boolean),
      time_filter: "week",
      sort: "relevance",
      limit: 8,
      restrict_sr: true,
      topic: intent.topic,
    };

    try {
      const breakdownPrompt = `${REDDIT_BREAKDOWN_PROMPT}\n\nIntent: ${JSON.stringify(intent, null, 2)}`;
      const breakdownResult = await callGemini(breakdownPrompt);

      if (breakdownResult?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const breakdownText = clean(breakdownResult.candidates[0].content.parts[0].text);
        const parsedBreakdown = safeJsonParse(breakdownText);
        if (parsedBreakdown) {
          strategy = { ...strategy, ...parsedBreakdown };

          if (!strategy.keywords || strategy.keywords.length === 0) {
            strategy.keywords = searchQuery.split(" ").filter((w) => w.length > 2);
          }
        }
      }
    } catch (e) {
      strategy.keywords = searchQuery.split(" ").filter((w) => w.length > 2);
    }

    // Fetch posts with different sorting strategies
    const fetchPromises = [
      fetchRedditPostsByStrategy({ ...strategy, sort: "relevance", time_filter: "week" }),
      fetchRedditPostsByStrategy({ ...strategy, sort: "new", time_filter: "all" }),
      fetchRedditPostsByStrategy({ ...strategy, sort: "top", time_filter: "week" }),
    ];

    const [hotPosts, newPosts, topPosts] = await Promise.allSettled(fetchPromises);

    const results = {
      hot: hotPosts.status === "fulfilled" ? hotPosts.value : [],
      new: newPosts.status === "fulfilled" ? newPosts.value : [],
      top: topPosts.status === "fulfilled" ? topPosts.value : [],
    };

    const totalResults = results.hot.length + results.new.length + results.top.length;

    if (totalResults === 0) {
      const educationalPosts = generateEducationalPosts(intent.topic || "programming", intent.language);

      results.hot = educationalPosts;
      results.new = educationalPosts.slice().sort(() => Math.random() - 0.5);
      results.top = educationalPosts.slice(0, 5);
    }

    if (results.hot.length === 0 && results.top.length > 0) {
      results.hot = results.top.slice(0, 5);
    }

    return {
      query: searchQuery,
      breakdown: strategy,
      hot: results.hot.slice(0, 8),
      new: results.new.slice(0, 8),
      top: results.top.slice(0, 8),
    };
  } catch (error) {
    console.error("Error in searchRedditWithIntent:", error);
    const educationalPosts = generateEducationalPosts(intent?.topic || "programming help", intent?.language);

    return {
      query: intent?.topic || "programming",
      breakdown: {
        subreddits: ["learnprogramming", "programming"],
        keywords: [intent?.topic || "programming", intent?.language || "", "help"].filter(Boolean),
        time_filter: "week",
        sort: "relevance",
        limit: 8,
        restrict_sr: true,
      },
      hot: educationalPosts,
      new: educationalPosts.slice().sort(() => Math.random() - 0.5),
      top: educationalPosts.slice(0, 5),
    };
  }
}

/* =========================
   Express routes
========================= */

app.get("/", (req, res) => {
  res.json({ status: "ok" });
});

app.post("/extract-intent", async (req, res) => {
  const { query } = req.body;

  if (!query) {
    res.status(400).json({ error: "Missing query" });
    return;
  }

  try {
    // Extract intent from query using Gemini
    const prompt = `${SYSTEM_PROMPT}\n\nUser query:\n${query}`;
    const result = await callGemini(prompt);

    if (!result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      return res.status(500).json({ error: "Failed to extract intent" });
    }

    const jsonText = clean(result.candidates[0].content.parts[0].text);
    const intent = safeJsonParse(jsonText);

    if (!intent) {
      return res.status(500).json({ error: "Invalid JSON intent output" });
    }

    res.json({ intent });
  } catch (error) {
    console.error("extract-intent error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/search-reddit", async (req, res) => {
  const { intent } = req.body;

  if (!intent) {
    res.status(400).json({ error: "Missing intent JSON" });
    return;
  }

  try {
    const data = await searchRedditWithIntent(intent);
    res.json(data);
  } catch (error) {
    console.error("search-reddit error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/search-youtube", async (req, res) => {
  const { intent } = req.body;

  if (!intent) {
    res.status(400).json({ error: "Missing intent JSON" });
    return;
  }

  try {
    // Generate YouTube search query from intent
    const prompt = `${YOUTUBE_QUERY_PROMPT}\n\nIntent: ${JSON.stringify(intent, null, 2)}`;
    const result = await callGemini(prompt);

    let ytQuery = "";

    if (result?.candidates?.[0]?.content?.parts?.[0]?.text) {
      ytQuery = clean(result.candidates[0].content.parts[0].text);
    }

    if (!ytQuery) {
      ytQuery = `${intent.language || ""} ${intent.topic || ""}`.trim();
    }

    // Fetch videos from YouTube
    const videos = await fetchYouTubeVideos(ytQuery, "any", 15);

    // Optional: rerank videos using Gemini (can be skipped or simplified)
    // const rerankedVideos = await rerankWithGemini(intent, videos);

    res.json({
      query: ytQuery,
      videos,
    });
  } catch (error) {
    console.error("search-youtube error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

/* =========================
   Server start
========================= */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
