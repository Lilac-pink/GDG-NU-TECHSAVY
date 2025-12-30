# Intent-Driven Search Engine for YouTube & Reddit

## Overview
This project enhances content discovery by extracting user intent from queries and generating optimized search queries tailored for YouTube and Reddit. Instead of simple keyword matching, it understands the user’s goal (e.g., learn, troubleshoot, compare) and delivers highly relevant search results, improving content relevance and user experience.

## Features
- **Intent Extraction:** Uses AI to identify the user’s true search intent and relevant details like topic, programming language, and complexity level.
- **Platform-Specific Query Generation:** Converts intent into optimized search queries customized for YouTube and Reddit.
- **Multi-Source Results:** Fetches, ranks, and filters content from YouTube videos and Reddit posts.
- **Fallback Educational Content:** Generates useful, educational placeholder content when relevant search results are scarce.
- **Configurable Search Strategies:** Dynamically selects subreddits, sorting, and filters based on user intent.

## Technologies Used
- Node.js, Express for backend API
- Google Gemini API for AI-powered intent extraction and query generation
- Reddit public API for searching posts
- YouTube Data API for video search
- dotenv for environment variable management
- CORS for cross-origin requests handling

## Getting Started

### Prerequisites
- Node.js (v14+)
- npm or yarn
- API keys for:
  - Google Gemini API
  - YouTube Data API

### Installation
1. Clone the repo:
   ```bash
   git clone https://github.com/yourusername/intent-search-engine.git
   cd intent-search-engine
2. Install dependencies:
    npm install
3. Create a .env file with:
    GEMINI_API_KEY=your_google_gemini_api_key
    YOUTUBE_API_KEY=your_youtube_api_key
    PORT=3000
4. Start the server:
    npm start

API Endpoints

POST /extract-intent
Input: { "text": "your search query" }
Output: Extracted intent and YouTube search results (short and long videos).

POST /reddit-search
Input: { "text": "your search query" }
Output: Extracted intent and Reddit posts categorized as hot, new, and top.

GET /health
Returns service status and API key availability.

How It Works

User submits a search query.

AI extracts detailed intent from the query.

Intent is transformed into optimized search queries specific to YouTube and Reddit.

Searches are performed on each platform with relevance ranking and filtering.

Results are returned to the user, ensuring relevance and diversity.

If no results, fallback educational posts are generated.

Future Improvements

Add support for more platforms (e.g., Stack Overflow, Twitter).

Enhance ranking with user feedback.

Integrate personalized search based on user history.

Support multilingual queries and results.

