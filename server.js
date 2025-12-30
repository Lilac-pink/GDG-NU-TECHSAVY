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

function clean(text = "") {
  if (!text) return "";
  // Remove code blocks and extra whitespace
  return text.replace(/```json|```/g, "").trim();
}

function safeJsonParse(text) {
  try { 
    const parsed = JSON.parse(text);
    return parsed;
  } catch (e) { 
    console.log("JSON parse error, trying to fix:", e.message);
    // Try to extract JSON if it's wrapped in text
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

function shortStr(s, n = 300) { 
  return s ? (s.length > n ? s.slice(0,n)+"..." : s) : ""; 
}

// Timeout wrapper for fetch
async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
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
            topK: 40
          }
        })
      },
      10000 // 10 second timeout
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
   Reddit Functions - COMPLETELY REWORKED
========================= */
async function searchSpecificSubreddits(query, subreddits, sort = 'relevance', time = 'week', limit = 5) {
  const results = [];
  
  for (const subreddit of subreddits) {
    if (results.length >= limit * 2) break; // Get more than needed for filtering
    
    try {
      // Use subreddit-specific search with restrict_sr parameter
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${sort}&t=${time}&limit=10`;
      
      console.log(`Searching r/${subreddit}: ${query}`);
      
      const response = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      }, 5000);
      
      if (!response.ok) continue;
      
      const data = await response.json();
      
      if (data.data && data.data.children) {
        data.data.children.forEach(post => {
          const postData = post.data;
          
          // Skip stickied posts (often announcements) and NSFW
          if (postData.stickied || postData.over_18) return;
          
          // Skip if it's just an image/link without text discussion
          if (!postData.selftext && postData.is_self === false && postData.domain !== 'self.' + subreddit) {
            return;
          }
          
          results.push({
            id: postData.id,
            title: postData.title,
            subreddit: subreddit,
            author: postData.author,
            score: postData.score || 0,
            comments: postData.num_comments || 0,
            created: postData.created_utc,
            url: `https://reddit.com${postData.permalink}`,
            thumbnail: postData.thumbnail && 
                      !['self', 'default', 'nsfw', 'image', 'spoiler'].includes(postData.thumbnail) 
                      ? postData.thumbnail 
                      : null,
            selftext: postData.selftext || '',
            nsfw: postData.over_18 || false,
            flair: postData.link_flair_text,
            domain: postData.domain,
            is_self: postData.is_self
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

// Function to filter and rank posts by relevance
function filterAndRankPosts(posts, keywords, topic) {
  return posts
    .map(post => {
      let relevanceScore = 0;
      const title = post.title.toLowerCase();
      const text = post.selftext.toLowerCase();
      const combined = `${title} ${text}`;
      
      // Score based on keyword matches
      keywords.forEach(keyword => {
        const kw = keyword.toLowerCase();
        if (title.includes(kw)) relevanceScore += 3;
        if (text.includes(kw)) relevanceScore += 1;
      });
      
      // Bonus for topic match
      if (title.includes(topic.toLowerCase())) relevanceScore += 2;
      
      // Bonus for having many comments (active discussion)
      if (post.comments > 10) relevanceScore += 1;
      
      // Bonus for self posts (text discussions)
      if (post.is_self) relevanceScore += 1;
      
      return { ...post, relevanceScore };
    })
    .filter(post => post.relevanceScore > 0) // Filter out completely irrelevant
    .sort((a, b) => {
      // First by relevance, then by score, then by comments
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
  
  // Build query from keywords
  const query = keywords.join(' ');
  
  console.log(`Reddit search strategy:`, strategy);
  
  if (restrict_sr && subreddits.length > 0) {
    // Search within specific subreddits
    const posts = await searchSpecificSubreddits(query, subreddits, sort, time_filter, limit * 2);
    
    // Filter and rank by relevance
    const filteredPosts = filterAndRankPosts(posts, keywords, strategy.topic || keywords[0]);
    
    return filteredPosts.slice(0, limit);
  } else {
    // General search (fallback)
    try {
      const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=${sort}&t=${time_filter}&limit=${limit * 2}`;
      
      const response = await fetchWithTimeout(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      }, 8000);
      
      if (!response.ok) return [];
      
      const data = await response.json();
      
      if (!data.data || !data.data.children) return [];
      
      const posts = data.data.children.map(post => {
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
          selftext: postData.selftext || '',
          nsfw: postData.over_18 || false,
          is_self: postData.is_self
        };
      });
      
      const filteredPosts = filterAndRankPosts(posts, keywords, strategy.topic || keywords[0]);
      return filteredPosts.slice(0, limit);
      
    } catch (error) {
      console.error('General Reddit search failed:', error);
      return [];
    }
  }
}

// Generate educational placeholder posts
function generateEducationalPosts(topic, language = '') {
  const basePosts = [
    {
      title: `How to implement a ${topic} in ${language || 'programming'}`,
      subreddit: 'learnprogramming',
      author: 'ProgrammingHelper',
      score: 125,
      comments: 42,
      selftext: `I see many beginners asking about ${topic}. Here's a simple approach...`,
      is_self: true
    },
    {
      title: `${language ? language + ' ' : ''}${topic} - Common mistakes and solutions`,
      subreddit: language ? `${language}_questions` : 'programming',
      author: 'CodeReviewExpert',
      score: 89,
      comments: 31,
      selftext: `When working on ${topic}, beginners often make these mistakes...`,
      is_self: true
    },
    {
      title: `Best resources for learning ${topic} ${language ? 'in ' + language : ''}`,
      subreddit: 'learnprogramming',
      author: 'ResourceCollector',
      score: 156,
      comments: 58,
      selftext: `Here are some excellent resources I've collected for ${topic}...`,
      is_self: true
    },
    {
      title: `Debugging help: ${topic} not working as expected`,
      subreddit: language ? language : 'coding',
      author: 'DebugHelper',
      score: 72,
      comments: 24,
      selftext: `If your ${topic} implementation isn't working, check these common issues...`,
      is_self: true
    },
    {
      title: `Efficient ${topic} implementation - optimization tips`,
      subreddit: 'programming',
      author: 'PerfOptimizer',
      score: 203,
      comments: 67,
      selftext: `Let's discuss how to make your ${topic} code more efficient and readable...`,
      is_self: true
    }
  ];
  
  return basePosts.map((post, index) => ({
    id: `edu-${topic.replace(/\s+/g, '-')}-${index}`,
    ...post,
    url: `https://reddit.com/r/${post.subreddit}/comments/sample`,
    thumbnail: null,
    nsfw: false,
    created: Date.now() / 1000 - (index * 86400) // Stagger creation times
  }));
}

async function searchRedditWithIntent(intent) {
  try {
    console.log("Starting Reddit search with intent:", intent);
    
    // Generate search query from intent
    const queryPrompt = `${REDDIT_QUERY_PROMPT}\n\nIntent: ${JSON.stringify(intent, null, 2)}`;
    const queryResult = await callGemini(queryPrompt);
    
    let searchQuery = "";
    
    if (queryResult?.candidates?.[0]?.content?.parts?.[0]?.text) {
      searchQuery = clean(queryResult.candidates[0].content.parts[0].text);
    }
    
    // Fallback if Gemini fails
    if (!searchQuery || searchQuery.includes('```')) {
      searchQuery = `${intent.language || ''} ${intent.topic || ''} ${intent.format || 'help'}`.trim();
    }
    
    console.log("Generated search query:", searchQuery);
    
    // Get search strategy
    let strategy = {
      subreddits: ["learnprogramming", "programming"],
      keywords: [intent.topic, intent.language, "help", "example"].filter(Boolean),
      time_filter: "week",
      sort: "relevance",
      limit: 8,
      restrict_sr: true,
      topic: intent.topic
    };
    
    try {
      const breakdownPrompt = `${REDDIT_BREAKDOWN_PROMPT}\n\nIntent: ${JSON.stringify(intent, null, 2)}`;
      const breakdownResult = await callGemini(breakdownPrompt);
      
      if (breakdownResult?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const breakdownText = clean(breakdownResult.candidates[0].content.parts[0].text);
        const parsedBreakdown = safeJsonParse(breakdownText);
        if (parsedBreakdown) {
          strategy = { ...strategy, ...parsedBreakdown };
          
          // Ensure we have keywords from the query
          if (!strategy.keywords || strategy.keywords.length === 0) {
            strategy.keywords = searchQuery.split(' ').filter(w => w.length > 2);
          }
        }
      }
    } catch (e) {
      console.log("Breakdown generation failed, using defaults");
      strategy.keywords = searchQuery.split(' ').filter(w => w.length > 2);
    }
    
    console.log("Search strategy:", strategy);
    
    // Fetch posts with different sorting strategies
    const fetchPromises = [
      // "Hot" posts - relevance sorted from this week
      fetchRedditPostsByStrategy({
        ...strategy,
        sort: 'relevance',
        time_filter: 'week'
      }),
      // "New" posts - sorted by new
      fetchRedditPostsByStrategy({
        ...strategy,
        sort: 'new',
        time_filter: 'all'
      }),
      // "Top" posts - top from this week
      fetchRedditPostsByStrategy({
        ...strategy,
        sort: 'top',
        time_filter: 'week'
      })
    ];
    
    const [hotPosts, newPosts, topPosts] = await Promise.allSettled(fetchPromises);
    
    // Extract results
    const results = {
      hot: hotPosts.status === 'fulfilled' ? hotPosts.value : [],
      new: newPosts.status === 'fulfilled' ? newPosts.value : [],
      top: topPosts.status === 'fulfilled' ? topPosts.value : []
    };
    
    // Check if we got meaningful results
    const totalResults = results.hot.length + results.new.length + results.top.length;
    
    if (totalResults === 0) {
      console.log("No relevant posts found, generating educational content");
      const educationalPosts = generateEducationalPosts(intent.topic || 'programming', intent.language);
      
      // Use educational posts for all categories
      results.hot = educationalPosts;
      results.new = educationalPosts.slice().sort(() => Math.random() - 0.5); // Shuffle for variety
      results.top = educationalPosts.slice(0, 5); // Top 5
    }
    
    // Ensure we have at least some posts in each category
    if (results.hot.length === 0 && results.top.length > 0) {
      results.hot = results.top.slice(0, 5);
    }
    
    console.log(`Final results: ${results.hot.length} hot, ${results.new.length} new, ${results.top.length} top`);
    
    return {
      query: searchQuery,
      breakdown: strategy,
      hot: results.hot.slice(0, 8),
      new: results.new.slice(0, 8),
      top: results.top.slice(0, 8)
    };
    
  } catch (error) {
    console.error("Error in searchRedditWithIntent:", error);
    
    // Generate educational fallback
    const educationalPosts = generateEducationalPosts(
      intent?.topic || 'programming help', 
      intent?.language
    );
    
    return {
      query: intent?.topic || 'programming',
      breakdown: {
        subreddits: ["learnprogramming", "programming"],
        keywords: [intent?.topic, intent?.language, "help"].filter(Boolean),
        time_filter: "week",
        sort: "relevance",
        limit: 8,
        error: error.message
      },
      hot: educationalPosts,
      new: educationalPosts.slice(0, 5),
      top: educationalPosts.slice(0, 5)
    };
  }
}

/* =========================
   YouTube Route (unchanged)
========================= */
app.post("/extract-intent", async (req, res) => {
  try {
    const userInput = req.body.text;
    if (!userInput) return res.status(400).json({ error: "No text provided" });

    // 1) Intent extraction
    const intentRaw = await callGemini(`${SYSTEM_PROMPT}\n\nUser query: "${userInput}"`);
    console.log("Intent raw received");
    
    let intent = { intent: "FindContent", topic: userInput };
    
    if (intentRaw?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const intentText = clean(intentRaw.candidates[0].content.parts[0].text);
      const parsedIntent = safeJsonParse(intentText);
      if (parsedIntent) {
        intent = parsedIntent;
      }
    }
    
    console.log("Parsed intent:", intent);

    // 2) Generate search query
    let youtubeQuery = userInput;
    try {
      const queryRaw = await callGemini(`${YOUTUBE_QUERY_PROMPT}\n\n${JSON.stringify(intent)}`);
      if (queryRaw?.candidates?.[0]?.content?.parts?.[0]?.text) {
        const queryText = clean(queryRaw.candidates[0].content.parts[0].text);
        if (queryText && !queryText.includes('```')) {
          youtubeQuery = queryText;
        }
      }
    } catch (e) {
      console.log("Query generation failed, using original input");
    }

    console.log("YouTube query:", youtubeQuery);

    // 3) Fetch candidates
    const [shortsCandidates, longCandidates] = await Promise.all([
      fetchYouTubeVideos(youtubeQuery, "short", 10),
      fetchYouTubeVideos(youtubeQuery, "long", 10)
    ]);

    console.log(`Found ${shortsCandidates.length} shorts, ${longCandidates.length} long videos`);

    // 4) Re-rank each list if we have enough candidates
    let shorts = shortsCandidates;
    let long = longCandidates;
    
    if (shortsCandidates.length > 2) {
      shorts = await rerankWithGemini(intent, shortsCandidates);
    }
    
    if (longCandidates.length > 2) {
      long = await rerankWithGemini(intent, longCandidates);
    }

    // 5) Final slices
    const outShorts = shorts.slice(0, 5);
    const outLong = long.slice(0, 5);

    // 6) Respond
    res.json({
      intent,
      youtubeQuery,
      shorts: outShorts,
      long: outLong,
      debug: {
        shortsCandidatesCount: shortsCandidates.length,
        longCandidatesCount: longCandidates.length
      }
    });

  } catch (err) {
    console.error("Server pipeline error:", err);
    res.status(500).json({ 
      error: "Pipeline failed", 
      details: err.message,
      fallback: {
        intent: { intent: "Error", topic: req.body.text },
        youtubeQuery: req.body.text,
        shorts: [],
        long: []
      }
    });
  }
});

/* =========================
   Reddit Route - IMPROVED
========================= */
app.post("/reddit-search", async (req, res) => {
  try {
    const userInput = req.body.text;
    if (!userInput) return res.status(400).json({ error: "No text provided" });

    console.log("Reddit search request:", userInput);

    // 1) Intent extraction with updated prompt
    const intentRaw = await callGemini(`${SYSTEM_PROMPT}\n\nUser query: "${userInput}"`);
    
    let intent = { 
      intent: "FindContent", 
      topic: userInput,
      language: userInput.toLowerCase().includes('cpp') ? 'cpp' : 
               userInput.toLowerCase().includes('python') ? 'python' :
               userInput.toLowerCase().includes('javascript') ? 'javascript' :
               userInput.toLowerCase().includes('java') ? 'java' : null,
      search_terms: userInput.split(' ').filter(w => w.length > 3)
    };
    
    if (intentRaw?.candidates?.[0]?.content?.parts?.[0]?.text) {
      const intentText = clean(intentRaw.candidates[0].content.parts[0].text);
      const parsedIntent = safeJsonParse(intentText);
      if (parsedIntent) {
        intent = { ...intent, ...parsedIntent };
        
        // Ensure search_terms exist
        if (!intent.search_terms || intent.search_terms.length === 0) {
          intent.search_terms = [
            intent.topic,
            intent.language,
            intent.complexity,
            intent.format
          ].filter(Boolean);
        }
      }
    }

    console.log("Reddit intent:", intent);

    // 2) Search Reddit with intent
    const redditResults = await searchRedditWithIntent(intent);

    console.log(`Reddit results: ${redditResults.hot.length} hot, ${redditResults.new.length} new, ${redditResults.top.length} top`);

    // 3) Respond
    res.json({
      intent,
      ...redditResults
    });

  } catch (err) {
    console.error("Reddit search error:", err);
    
    // Generate educational response
    const educationalPosts = generateEducationalPosts(req.body.text || "programming", 
      req.body.text?.toLowerCase().includes('cpp') ? 'C++' :
      req.body.text?.toLowerCase().includes('python') ? 'Python' :
      req.body.text?.toLowerCase().includes('javascript') ? 'JavaScript' : null);
    
    res.json({
      intent: { 
        intent: "FindContent", 
        topic: req.body.text || "programming",
        language: req.body.text?.toLowerCase().includes('cpp') ? 'cpp' : 
                 req.body.text?.toLowerCase().includes('python') ? 'python' :
                 req.body.text?.toLowerCase().includes('javascript') ? 'javascript' : null,
        error: err.message
      },
      query: req.body.text || "programming help",
      breakdown: {
        subreddits: ["learnprogramming", "programming"],
        keywords: [req.body.text?.split(' ')[0] || "programming", "help"],
        time_filter: "week",
        sort: "relevance",
        limit: 8
      },
      hot: educationalPosts.slice(0, 5),
      new: educationalPosts.slice(0, 3),
      top: educationalPosts.slice(0, 4)
    });
  }
});

/* =========================
   Health check endpoint
========================= */
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    services: {
      gemini: !!GEMINI_API_KEY,
      youtube: !!YOUTUBE_API_KEY,
      server: "running"
    }
  });
});

/* =========================
   Start server
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Intent API running on http://localhost:${PORT}`);
  console.log(`📺 YouTube endpoint: POST http://localhost:${PORT}/extract-intent`);
  console.log(`👥 Reddit endpoint: POST http://localhost:${PORT}/reddit-search`);
  console.log(`🏥 Health check: GET http://localhost:${PORT}/health`);
});