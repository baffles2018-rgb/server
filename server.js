const express = require("express");

const app = express();
app.use(express.json());

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }

  return response.json();
}

async function getUserGames(userId) {
  let cursor = "";
  const allGames = [];

  while (true) {
    const url =
      `https://games.roproxy.com/v2/users/${encodeURIComponent(userId)}/games` +
      `?accessFilter=2&limit=50&sortOrder=Asc` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");

    const data = await fetchJson(url);
    const items = Array.isArray(data.data) ? data.data : [];
    allGames.push(...items);

    if (!data.nextPageCursor) {
      break;
    }

    cursor = data.nextPageCursor;
  }

  return allGames;
}

async function getUniversePasses(universeId) {
  let cursor = "";
  const allPasses = [];

  while (true) {
    const url =
      `https://apis.roproxy.com/game-passes/v1/universes/${encodeURIComponent(universeId)}/game-passes` +
      `?limit=100&sortOrder=Asc` +
      (cursor ? `&pageToken=${encodeURIComponent(cursor)}` : "");

    const data = await fetchJson(url);

    const items =
      Array.isArray(data.gamePasses) ? data.gamePasses :
      Array.isArray(data.data) ? data.data :
      [];

    allPasses.push(...items);

    const nextToken = data.nextPageToken || data.nextPageCursor || "";
    if (!nextToken) {
      break;
    }

    cursor = nextToken;
  }

  return allPasses;
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

    const games = await getUserGames(userId);

    const seenUniverseIds = new Set();
    const seenPassIds = new Set();
    const passItems = [];

    for (const game of games) {
      const universeId = Number(game.id || game.rootPlace?.universeId || game.universeId);

      if (!Number.isFinite(universeId) || seenUniverseIds.has(universeId)) {
        continue;
      }

      seenUniverseIds.add(universeId);

      try {
        const passes = await getUniversePasses(universeId);

        for (const pass of passes) {
          const passId = Number(
            pass.id ||
            pass.gamePassId ||
            pass.passId ||
            (typeof pass.path === "string" ? pass.path.split("/").pop() : 0)
          );

          if (!Number.isFinite(passId) || seenPassIds.has(passId)) {
            continue;
          }

          seenPassIds.add(passId);
          passItems.push({ PassId: passId });
        }
      } catch (err) {
        console.error(`Failed to fetch passes for universe ${universeId}:`, err.message);
      }
    }

    return res.json({
      success: true,
      items: passItems
    });
  } catch (error) {
    console.error("roblox-passes error:", error.message);

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
