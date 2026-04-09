const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_KEY = String(process.env.API_KEY || "").trim();
const DB_PATH = path.resolve(process.env.DB_PATH || "./donations.db");

/*
  Node 18+ required for global fetch.
  Optional envs:
  - CATALOG_BASE_URL=https://catalog.roproxy.com
  - GAMES_BASE_URL=https://games.roproxy.com
  - PASSES_BASE_URL=https://apis.roproxy.com
  - ROBLOX_CREATOR_NAME=Roblox
  - ROBLOX_CREATOR_ID=1
*/
const CATALOG_BASE_URL = String(process.env.CATALOG_BASE_URL || "https://catalog.roproxy.com").replace(/\/+$/, "");
const GAMES_BASE_URL = String(process.env.GAMES_BASE_URL || "https://games.roproxy.com").replace(/\/+$/, "");
const PASSES_BASE_URL = String(process.env.PASSES_BASE_URL || "https://apis.roproxy.com").replace(/\/+$/, "");
const ROBLOX_CREATOR_NAME = String(process.env.ROBLOX_CREATOR_NAME || "Roblox").trim();
const ROBLOX_CREATOR_ID = Number(process.env.ROBLOX_CREATOR_ID || 1);

if (!global.fetch) {
  console.error("This backend requires Node 18+ because it uses the built-in fetch API.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("Missing API_KEY environment variable.");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS donations (
    id TEXT PRIMARY KEY,
    fromUserId INTEGER NOT NULL,
    fromUsername TEXT NOT NULL,
    toUserId INTEGER NOT NULL,
    toUsername TEXT NOT NULL,
    amount INTEGER NOT NULL,
    gameId INTEGER NOT NULL DEFAULT 0,
    placeId INTEGER NOT NULL DEFAULT 0,
    purchaseId TEXT,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_donations_timestamp ON donations(timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_donations_gameId ON donations(gameId);
  CREATE INDEX IF NOT EXISTS idx_donations_fromUserId ON donations(fromUserId);
  CREATE INDEX IF NOT EXISTS idx_donations_toUserId ON donations(toUserId);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_donations_purchaseId ON donations(purchaseId);
`);

function requireApiKey(req, res, next) {
  const providedKey = String(req.header("x-api-key") || "").trim();

  if (!providedKey || providedKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 CatalogBackend/1.0",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} for ${url}: ${text}`);
  }

  return response.json();
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toNonNegativeInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function sanitizeString(value, maxLen = 80) {
  return String(value || "").replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, maxLen);
}

function normalizeBool(value) {
  if (value === true || value === "true" || value === "1" || value === 1) {
    return true;
  }
  return false;
}

function isRobloxCreator(item) {
  const creatorName =
    String(
      item?.creatorName ||
      item?.creator?.name ||
      item?.creator?.creatorName ||
      ""
    ).trim();

  const creatorId =
    Number(
      item?.creatorTargetId ??
      item?.creatorId ??
      item?.creator?.id ??
      item?.creator?.creatorTargetId ??
      0
    );

  if (creatorId > 0 && Number.isFinite(ROBLOX_CREATOR_ID) && creatorId === ROBLOX_CREATOR_ID) {
    return true;
  }

  return creatorName.toLowerCase() === ROBLOX_CREATOR_NAME.toLowerCase();
}

function detectLimited(item) {
  const collectible =
    item?.collectibleItemId ||
    item?.collectibleProductId ||
    item?.isLimited ||
    item?.isLimitedUnique;

  if (collectible) {
    return true;
  }

  const itemRestrictions = Array.isArray(item?.itemRestrictions) ? item.itemRestrictions : [];
  for (const restriction of itemRestrictions) {
    const lowered = String(restriction || "").toLowerCase();
    if (lowered.includes("limited")) {
      return true;
    }
  }

  const priceStatus = String(item?.priceStatus || "").toLowerCase();
  if (priceStatus.includes("limited")) {
    return true;
  }

  return false;
}

function normalizeItemType(item) {
  const rawType =
    String(
      item?.itemType ||
      item?.itemTypeDisplayName ||
      (item?.bundleType ? "Bundle" : "Asset")
    ).trim();

  return rawType || "Asset";
}

function normalizeThumbnail(item) {
  const explicit =
    item?.thumbnailUrl ||
    item?.thumbnail ||
    item?.imageUrl ||
    item?.itemImageId;

  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim();
  }

  const id = Number(item?.id || item?.itemId || 0);
  if (!Number.isFinite(id) || id <= 0) {
    return "";
  }

  const itemType = normalizeItemType(item);
  if (itemType.toLowerCase() === "bundle") {
    return `rbxthumb://type=BundleThumbnail&id=${id}&w=420&h=420`;
  }

  return `rbxthumb://type=Asset&id=${id}&w=420&h=420`;
}

function normalizePrice(item) {
  const price =
    item?.price ??
    item?.lowestPrice ??
    item?.unitsAvailableForConsumption ??
    0;

  const n = Number(price);
  return Number.isFinite(n) ? n : 0;
}

function normalizeDescription(item) {
  return String(item?.description || item?.itemDescription || "").trim();
}

function normalizeCreatorName(item) {
  return String(
    item?.creatorName ||
    item?.creator?.name ||
    item?.creator?.creatorName ||
    "Unknown"
  ).trim() || "Unknown";
}

function normalizeAssetType(item) {
  return String(
    item?.assetType ||
    item?.assetTypeName ||
    item?.assetTypeDisplayName ||
    ""
  ).trim();
}

function normalizeBundleType(item) {
  return String(item?.bundleType || item?.bundleTypeName || "").trim();
}

function buildTags(item) {
  const tags = [];
  const limited = detectLimited(item);

  if (limited) {
    tags.push("LIMITED");
  }

  if (isRobloxCreator(item)) {
    tags.push("ROBLOX");
  } else {
    tags.push("UGC");
  }

  return tags.length > 0 ? tags.join(" • ") : "NONE";
}

function normalizeCatalogItem(item) {
  const id = Number(item?.id || item?.itemId || 0);
  const itemType = normalizeItemType(item);
  const price = normalizePrice(item);
  const priceStatus = String(item?.priceStatus || "").trim();
  const creatorName = normalizeCreatorName(item);
  const isForSale =
    item?.isForSale === true ||
    priceStatus === "" ||
    /^onsale$/i.test(priceStatus) ||
    price >= 0;

  return {
    Id: id,
    ItemType: itemType,
    Name: String(item?.name || item?.itemName || "Item").trim() || "Item",
    Description: normalizeDescription(item),
    CreatorName: creatorName,
    CreatorTargetId: Number(
      item?.creatorTargetId ??
      item?.creatorId ??
      item?.creator?.id ??
      item?.creator?.creatorTargetId ??
      0
    ) || 0,
    Price: price,
    PriceStatus: priceStatus,
    IsForSale: isForSale,
    Thumbnail: normalizeThumbnail(item),
    AssetType: normalizeAssetType(item),
    BundleType: normalizeBundleType(item),
    IsRobloxCreated: isRobloxCreator(item),
    IsLimited: detectLimited(item),
    Tags: buildTags(item)
  };
}

function getAllDonations(gameId) {
  if (Number.isFinite(gameId)) {
    return db.prepare(`
      SELECT *
      FROM donations
      WHERE gameId = ?
      ORDER BY timestamp DESC
    `).all(gameId);
  }

  return db.prepare(`
    SELECT *
    FROM donations
    ORDER BY timestamp DESC
  `).all();
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
    cutoff = startOfTodayUTC().toISOString();
  } else if (period === "week") {
    cutoff = startOfWeekUTC().toISOString();
  }

  if (!cutoff) {
    return items;
  }

  return items.filter(item => item.timestamp >= cutoff);
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

async function getUserGames(userId) {
  let cursor = "";
  const allGames = [];

  while (true) {
    const url =
      `${GAMES_BASE_URL}/v2/users/${encodeURIComponent(userId)}/games` +
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
      `${PASSES_BASE_URL}/game-passes/v1/universes/${encodeURIComponent(universeId)}/game-passes` +
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

function buildCategoryParams(category) {
  const c = String(category || "all").toLowerCase();

  // These are broad website-catalog hints. They do not need to be perfect because
  // we normalize/filter again afterward.
  switch (c) {
    case "accessories":
      return {
        category: "Accessories",
        fallbackKeywords: "hat accessory"
      };
    case "clothing":
      return {
        category: "Clothing",
        fallbackKeywords: "shirt clothing"
      };
    case "body":
      return {
        category: "BodyParts",
        fallbackKeywords: "face head body"
      };
    case "animations":
      return {
        category: "Animations",
        fallbackKeywords: "animation emote"
      };
    case "bundles":
      return {
        category: "Characters",
        fallbackKeywords: "bundle"
      };
    case "all":
    default:
      return {
        category: "",
        fallbackKeywords: "avatar"
      };
  }
}

function buildSortType(sort) {
  const value = String(sort || "relevance").toLowerCase();
  if (value === "pricelow") return 3;
  if (value === "pricehigh") return 4;
  return 0;
}

function appendIf(params, key, value) {
  if (value !== undefined && value !== null && value !== "") {
    params.set(key, String(value));
  }
}

async function searchCatalogPage({
  keyword,
  category,
  sort,
  limit,
  cursor,
  creatorName,
  creatorTargetId,
  includeOffSale
}) {
  const url = new URL(`${CATALOG_BASE_URL}/v1/search/items/details`);
  url.searchParams.set("Keyword", keyword);
  url.searchParams.set("Limit", String(limit));
  url.searchParams.set("SortType", String(buildSortType(sort)));
  url.searchParams.set("IncludeNotForSale", includeOffSale ? "true" : "false");
  url.searchParams.set("SalesTypeFilter", "1");

  const { category: catalogCategory } = buildCategoryParams(category);
  appendIf(url.searchParams, "Category", catalogCategory);
  appendIf(url.searchParams, "Cursor", cursor);
  appendIf(url.searchParams, "CreatorName", creatorName);
  appendIf(url.searchParams, "CreatorTargetId", creatorTargetId);

  return fetchJson(url.toString());
}

function dedupeById(items) {
  const out = [];
  const seen = new Set();

  for (const item of items) {
    const id = Number(item?.Id || item?.id || 0);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) {
      continue;
    }

    seen.add(id);
    out.push(item);
  }

  return out;
}

function categoryMatches(item, category) {
  const c = String(category || "all").toLowerCase();
  if (c === "all") {
    return true;
  }

  const assetType = String(item.AssetType || "").toLowerCase();
  const itemType = String(item.ItemType || "").toLowerCase();
  const bundleType = String(item.BundleType || "").toLowerCase();

  if (c === "accessories") {
    return [
      "hat",
      "hairaccessory",
      "faceaccessory",
      "neckaccessory",
      "shoulderaccessory",
      "frontaccessory",
      "backaccessory",
      "waistaccessory"
    ].includes(assetType);
  }

  if (c === "clothing") {
    return ["shirt", "pants", "tshirt", "classicshirt", "classicpants", "classictshirt"].includes(assetType);
  }

  if (c === "body") {
    return ["face", "head", "torso", "leftarm", "rightarm", "leftleg", "rightleg"].includes(assetType);
  }

  if (c === "animations") {
    return [
      "runanimation",
      "walkanimation",
      "jumpanimation",
      "fallanimation",
      "climbanimation",
      "idleanimation",
      "swimanimation",
      "poseanimation",
      "emoteanimation"
    ].includes(assetType);
  }

  if (c === "bundles") {
    if (itemType !== "bundle") {
      return false;
    }

    if (!bundleType) {
      return true;
    }

    return ["bodyparts", "animations"].includes(bundleType);
  }

  return true;
}

async function searchCatalogWithFallback({
  search,
  category,
  sort,
  page,
  pageSize,
  robloxOnly
}) {
  const requestedPage = toPositiveInt(page, 1);
  const safePageSize = Math.max(1, Math.min(60, toPositiveInt(pageSize, 30)));
  const { fallbackKeywords } = buildCategoryParams(category);
  const keyword = sanitizeString(search || "", 80) || fallbackKeywords;
  const includeOffSale = false;

  const desiredCount = requestedPage * safePageSize;
  const broadResults = [];
  let finalCursor = "";
  let reachedEnd = false;

  // Try proper creator-filter request first when Roblox-only is enabled.
  if (robloxOnly) {
    try {
      let creatorCursor = "";
      let creatorPages = 0;

      while (broadResults.length < desiredCount && creatorPages < 15) {
        creatorPages += 1;

        const data = await searchCatalogPage({
          keyword,
          category,
          sort,
          limit: 30,
          cursor: creatorCursor,
          creatorName: ROBLOX_CREATOR_NAME,
          creatorTargetId: ROBLOX_CREATOR_ID,
          includeOffSale
        });

        const rows = Array.isArray(data.data) ? data.data : [];
        const normalized = rows.map(normalizeCatalogItem).filter(item => categoryMatches(item, category));

        broadResults.push(...normalized);

        creatorCursor = data.nextPageCursor || data.nextPageToken || "";
        if (!creatorCursor || rows.length === 0) {
          reachedEnd = true;
          break;
        }
      }
    } catch (err) {
      console.warn("Creator-filtered catalog search failed, falling back to manual filtering:", err.message);
    }
  }

  // Fallback: broad search + manual Roblox filter.
  if (broadResults.length < desiredCount) {
    let cursor = "";
    let pages = 0;

    while (broadResults.length < desiredCount && pages < 60) {
      pages += 1;

      const data = await searchCatalogPage({
        keyword,
        category,
        sort,
        limit: 30,
        cursor,
        includeOffSale
      });

      const rows = Array.isArray(data.data) ? data.data : [];
      let normalized = rows.map(normalizeCatalogItem);

      if (robloxOnly) {
        normalized = normalized.filter(item => item.IsRobloxCreated);
      }

      normalized = normalized.filter(item => categoryMatches(item, category));
      broadResults.push(...normalized);

      cursor = data.nextPageCursor || data.nextPageToken || "";
      finalCursor = cursor;

      if (!cursor || rows.length === 0) {
        reachedEnd = true;
        break;
      }
    }
  }

  const deduped = dedupeById(broadResults);
  const startIndex = (requestedPage - 1) * safePageSize;
  const items = deduped.slice(startIndex, startIndex + safePageSize);
  const isFinished = reachedEnd && deduped.length <= startIndex + safePageSize;

  return {
    success: true,
    page: requestedPage,
    pageSize: safePageSize,
    isFinished,
    nextCursor: finalCursor || "",
    items
  };
}

async function getCatalogItemDetails(itemId) {
  const id = toPositiveInt(itemId, 0);
  if (!id) {
    throw new Error("Invalid item id");
  }

  const url = new URL(`${CATALOG_BASE_URL}/v1/catalog/items/details`);
  url.searchParams.set("itemIds", String(id));

  const data = await fetchJson(url.toString());
  const rows = Array.isArray(data.data) ? data.data : [];
  if (rows.length === 0) {
    return null;
  }

  return normalizeCatalogItem(rows[0]);
}

app.get("/", (req, res) => {
  return res.json({
    success: true,
    message: "Backend is running"
  });
});

app.get("/catalog/search", async (req, res) => {
  try {
    const result = await searchCatalogWithFallback({
      search: req.query.search,
      category: req.query.category,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize || req.query.limit,
      robloxOnly: normalizeBool(req.query.robloxOnly)
    });

    return res.json(result);
  } catch (error) {
    console.error("GET /catalog/search error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to search catalog"
    });
  }
});

app.get("/catalog/item/:id", async (req, res) => {
  try {
    const item = await getCatalogItemDetails(req.params.id);

    if (!item) {
      return res.status(404).json({
        success: false,
        message: "Item not found"
      });
    }

    return res.json({
      success: true,
      item
    });
  } catch (error) {
    console.error("GET /catalog/item/:id error:", error.message);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch catalog item"
    });
  }
});

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

    passItems.sort((a, b) => a.PassId - b.PassId);

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

app.post("/donations", requireApiKey, (req, res) => {
  try {
    const {
      fromUserId,
      fromUsername,
      toUserId,
      toUsername,
      amount,
      gameId,
      placeId,
      purchaseId
    } = req.body || {};

    const donorId = Number(fromUserId);
    const receiverId = Number(toUserId);
    const donationAmount = Number(amount);
    const parsedGameId = Number(gameId || 0);
    const parsedPlaceId = Number(placeId || 0);
    const normalizedPurchaseId = String(purchaseId || "").trim();

    if (
      !Number.isFinite(donorId) ||
      !Number.isFinite(receiverId) ||
      !Number.isFinite(donationAmount) ||
      donationAmount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid donation data"
      });
    }

    if (!normalizedPurchaseId) {
      return res.status(400).json({
        success: false,
        message: "Missing purchaseId"
      });
    }

    const existing = db.prepare(`
      SELECT id
      FROM donations
      WHERE purchaseId = ?
      LIMIT 1
    `).get(normalizedPurchaseId);

    if (existing) {
      return res.json({
        success: true,
        duplicate: true,
        message: "Donation already recorded"
      });
    }

    const donation = {
      id: `don_${Date.now()}_${Math.floor(Math.random() * 1000000)}`,
      fromUserId: donorId,
      fromUsername: String(fromUsername || "Unknown"),
      toUserId: receiverId,
      toUsername: String(toUsername || "Unknown"),
      amount: donationAmount,
      gameId: Number.isFinite(parsedGameId) ? parsedGameId : 0,
      placeId: Number.isFinite(parsedPlaceId) ? parsedPlaceId : 0,
      purchaseId: normalizedPurchaseId,
      timestamp: new Date().toISOString()
    };

    db.prepare(`
      INSERT INTO donations (
        id,
        fromUserId,
        fromUsername,
        toUserId,
        toUsername,
        amount,
        gameId,
        placeId,
        purchaseId,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      donation.id,
      donation.fromUserId,
      donation.fromUsername,
      donation.toUserId,
      donation.toUsername,
      donation.amount,
      donation.gameId,
      donation.placeId,
      donation.purchaseId,
      donation.timestamp
    );

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

    let items = getAllDonations(gameId);
    items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

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

    let items = getAllDonations(gameId);
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

    let items = getAllDonations(gameId);
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

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
  console.log(`Using SQLite database at: ${DB_PATH}`);
  console.log(`Catalog base URL: ${CATALOG_BASE_URL}`);
});
