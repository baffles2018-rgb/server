const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const DB_PATH = path.join(__dirname, "database.json");

function readDatabase() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { donations: [] };
    }

    const raw = fs.readFileSync(DB_PATH, "utf8");
    const parsed = JSON.parse(raw);

    if (!parsed.donations || !Array.isArray(parsed.donations)) {
      return { donations: [] };
    }

    return parsed;
  } catch (error) {
    console.error("Failed to read database:", error.message);
    return { donations: [] };
  }
}

function writeDatabase(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to write database:", error.message);
    throw error;
  }
}

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

function startOfTodayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfWeekUTC() {
  const now = new Date();
  const day = now.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - diff);
  return start;
}

function filterByPeriod(items, period) {
  if (period === "alltime") {
    return items;
  }

  let cutoff = null;

  if (period === "today") {
    cutoff = startOfTodayUTC();
  } else if (period === "week") {
    cutoff = startOfWeekUTC();
  }

  if (!cutoff) {
    return items;
  }

  return items.filter(item => new Date(item.timestamp) >= cutoff);
}

function buildDonationLeaderboard(donations, type) {
  const map = new Map();

  for (const donation of donations) {
    const userId = type === "donated" ? donation.fromUserId : donation.toUserId;
    const username = type === "donated" ? donation.fromUsername : donation.toUsername;
    const amount = Number(donation.amount) || 0;

    if (!map.has(userId)) {
      map.set(userId, {
        userId,
        username,
        amount: 0
      });
    }

    map.get(userId).amount += amount;
  }

  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
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

app.post("/donations", (req, res) => {
  try {
    const {
      fromUserId,
      fromUsername,
      toUserId,
      toUsername,
      amount,
      gameId,
      placeId
    } = req.body || {};

    if (
      !Number.isFinite(Number(fromUserId)) ||
      !Number.isFinite(Number(toUserId)) ||
      !Number.isFinite(Number(amount)) ||
      Number(amount) <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid donation data"
      });
    }

    const donation = {
      id: `don_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
      fromUserId: Number(fromUserId),
      fromUsername: String(fromUsername || "Unknown"),
      toUserId: Number(toUserId),
      toUsername: String(toUsername || "Unknown"),
      amount: Number(amount),
      gameId: Number(gameId || 0),
      placeId: Number(placeId || 0),
      timestamp: new Date().toISOString()
    };

    const db = readDatabase();
    db.donations.push(donation);
    writeDatabase(db);

    return res.json({
      success: true,
      donation
    });
  } catch (error) {
    console.error("POST /donations error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to save donation"
    });
  }
});

app.get("/donations/recent", (req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    const db = readDatabase();
    let items = [...db.donations];

    if (Number.isFinite(gameId)) {
      items = items.filter(item => Number(item.gameId) === gameId);
    }

    items.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    return res.json({
      success: true,
      items: items.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /donations/recent error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent donations"
    });
  }
});

app.get("/leaderboards/donators/:period", (req, res) => {
  try {
    const period = String(req.params.period || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    if (!["today", "week", "alltime"].includes(period)) {
      return res.status(400).json({
        success: false,
        message: "Invalid period"
      });
    }

    const db = readDatabase();
    let items = [...db.donations];

    if (Number.isFinite(gameId)) {
      items = items.filter(item => Number(item.gameId) === gameId);
    }

    items = filterByPeriod(items, period);

    const leaderboard = buildDonationLeaderboard(items, "donated");

    return res.json({
      success: true,
      period,
      items: leaderboard.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /leaderboards/donators/:period error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch donator leaderboard"
    });
  }
});

app.get("/leaderboards/raised/:period", (req, res) => {
  try {
    const period = String(req.params.period || "").toLowerCase();
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const gameId = req.query.gameId ? Number(req.query.gameId) : null;

    if (!["today", "week", "alltime"].includes(period)) {
      return res.status(400).json({
        success: false,
        message: "Invalid period"
      });
    }

    const db = readDatabase();
    let items = [...db.donations];

    if (Number.isFinite(gameId)) {
      items = items.filter(item => Number(item.gameId) === gameId);
    }

    items = filterByPeriod(items, period);

    const leaderboard = buildDonationLeaderboard(items, "raised");

    return res.json({
      success: true,
      period,
      items: leaderboard.slice(0, limit)
    });
  } catch (error) {
    console.error("GET /leaderboards/raised/:period error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch raised leaderboard"
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
