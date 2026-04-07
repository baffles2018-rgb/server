const express = require("express");

const app = express();

/*
Render Environment Variables you need:
ROBLOX_API_KEY=your_open_cloud_api_key

Optional:
PORT=3000

This map is the part you edit for now.
It tells the backend which universe IDs belong to which user.
Later, you can move this to a database if you want.
*/
const USER_UNIVERSES = {
  "5364064": [7365282196]
};

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY;

if (!ROBLOX_API_KEY) {
  console.warn("ROBLOX_API_KEY is missing. The backend will not work correctly.");
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }

  return response.json();
}

async function listGamePassesByUniverse(universeId) {
  const allItems = [];
  let pageToken = "";

  while (true) {
    const url =
      `https://apis.roblox.com/game-passes/v1/universes/${universeId}/game-passes/creator` +
      (pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "");

    const data = await fetchJson(url, {
      method: "GET",
      headers: {
        "x-api-key": ROBLOX_API_KEY,
        "Content-Type": "application/json"
      }
    });

    const items = Array.isArray(data.gamePasses) ? data.gamePasses : [];
    allItems.push(...items);

    if (!data.nextPageToken) {
      break;
    }

    pageToken = data.nextPageToken;
  }

  return allItems;
}

app.get("/roblox-passes", async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({
        success: false,
        message: "Missing userId"
      });
    }

    const universeIds = USER_UNIVERSES[userId] || [];

    if (universeIds.length === 0) {
      return res.json({
        success: true,
        items: []
      });
    }

    const seen = new Set();
    const results = [];

    for (const universeId of universeIds) {
      const gamePasses = await listGamePassesByUniverse(universeId);

      for (const pass of gamePasses) {
        const passId = Number(pass.path ? pass.path.split("/").pop() : pass.id);

        if (!Number.isFinite(passId) || seen.has(passId)) {
          continue;
        }

        seen.add(passId);

        results.push({
          PassId: passId
        });
      }
    }

    return res.json({
      success: true,
      items: results
    });
  } catch (error) {
    console.error("roblox-passes error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch passes"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
