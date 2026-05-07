const express = require("express");
const rbx = require("noblox.js");
const dotenv = require("dotenv");

dotenv.config();

const app = express();
app.use(express.json());

// =============================
// CONFIG
// =============================
const COOKIE = process.env.COOKIE;

if (!COOKIE) {
	console.error("❌ Missing COOKIE");
	process.exit(1);
}

const VALID_KEYS = new Set([
	"9e2c7b4f1a6d0e8f5c3b9a4d7e1f2c8b6a5" // [PNP] - Philippine National Police 10148023, 2month bago expire
]);

const KEY_BINDINGS = new Map();

// =============================
// LICENSE
// =============================
function validateKey(key, placeId) {
	if (!key || !placeId) return { ok: false };
	if (!VALID_KEYS.has(key)) return { ok: false };

	const bound = KEY_BINDINGS.get(key);

	if (!bound) {
		KEY_BINDINGS.set(key, placeId);
		return { ok: true };
	}

	if (bound !== placeId) return { ok: false };

	return { ok: true };
}

function requireLicense(req, res) {
	const key = req.query.key;
	const placeId = Number(req.query.placeid);

	const result = validateKey(key, placeId);
	if (!result.ok) {
		res.status(403).json({ ok: false, error: "INVALID_LICENSE" });
		return null;
	}

	return { key, placeId };
}

// =============================
// WEBHOOK
// =============================
async function sendWebhook(payload) {
	const url = process.env.WEBHOOK_URL;
	if (!url) return;

	try {
		await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload),
		});
	} catch (e) {
		console.log("Webhook error:", e.message);
	}
}

// =============================
// DONATION PROXY HELPERS (CACHE)
// =============================
const inventoryCache = new Map();
const CACHE_DURATION_MS = 2 * 60 * 1000; // 2 minutes (120,000 milliseconds)

async function fetchUserDonationItems(userId) {
	let items = [];
	try {
		// 1. Scan for public games
		const gamesRes = await fetch(`https://games.roblox.com/v2/users/${userId}/games?accessFilter=2&sortOrder=Asc&limit=50`);
		if (!gamesRes.ok) throw new Error("Failed to fetch games");
		const gamesData = await gamesRes.json();

		console.log(`🎮 Found ${gamesData.data.length} public games. Scanning for passes...`);

		// 2. Scan each game for Gamepasses
		for (const game of gamesData.data) {
			const passesRes = await fetch(`https://games.roblox.com/v1/games/${game.rootPlace.id}/game-passes?limit=100&sortOrder=Asc`);
			if (passesRes.ok) {
				const passesData = await passesRes.json();
				for (const pass of passesData.data) {
					// Only grab items that actually cost Robux
					if (pass.price > 0) { 
						items.push({
							Id: pass.id,
							Type: "GamePass",
							Price: pass.price,
							ImageId: pass.id 
						});
					}
				}
			}
		}
		return items;
	} catch (error) {
		console.log("Roblox API Error:", error.message);
		return null; // Return null so the router knows the API failed
	}
}

// =============================
// START ROBLOX
// =============================
async function start() {
	await rbx.setCookie(COOKIE);
	console.log("✅ Logged into Roblox backend");
	
	// =============================
	// CHECK KEY
	// =============================
	app.get("/checkkey", (req, res) => {
		const key = req.query.key;

		// Verify key exists in the VALID_KEYS set
		if (!key || !VALID_KEYS.has(key)) {
			return res.status(403).json({ ok: false, error: "INVALID_LICENSE" });
		}

		return res.json({ ok: true, message: "API Key Valid" });
	});
	
	// =============================
	// SETRANK (ONLY ENDPOINT)
	// =============================
	app.get("/setrank", async (req, res) => {
		const lic = requireLicense(req, res);
		if (!lic) return;

		const userId = Number(req.query.userid);
		const rank = Number(req.query.rank);
		const groupId = Number(req.query.groupid);

		if (!userId || !rank || !groupId) {
			return res.status(400).json({ ok: false });
		}

		try {
			const current = await rbx.getRankInGroup(groupId, userId);

			if (current === rank) {
				return res.json({ ok: true, ignored: true });
			}

			await rbx.setRank(groupId, userId, rank);

			// 🔥 SINGLE LOG SYSTEM
			await sendWebhook({
				event: "rank_change",
				userId,
				groupId,
				from: current,
				to: rank,
				placeId: lic.placeId
			});

			return res.json({
				ok: true,
				from: current,
				to: rank
			});

		} catch (e) {
			console.log(e);
			res.status(500).json({ ok: false });
		}
	});

	// =============================
	// DONATION PROXY (WITH CACHING)
	// =============================
	app.get("/api/items/:userId", async (req, res) => {
		const userId = req.params.userId;

		// 1. THE SHIELD: Check if we have this user cached recently
		if (inventoryCache.has(userId)) {
			const cachedData = inventoryCache.get(userId);
			
			// If the cache is less than 2 minutes old, serve it instantly!
			if (Date.now() - cachedData.timestamp < CACHE_DURATION_MS) {
				console.log(`⚡ [CACHE HIT] Sent ${cachedData.items.length} personal items for User: ${userId}`);
				return res.json(cachedData.items);
			}
		}

		// 2. Cache is empty or expired, time to fetch live data
		console.log(`\n👤 Searching personal items for User: ${userId}`);
		const liveItems = await fetchUserDonationItems(userId);

		if (liveItems !== null) {
			// 3. API Success! Save the data to the memory vault
			inventoryCache.set(userId, {
				items: liveItems,
				timestamp: Date.now()
			});
			console.log(`✅ Sent ${liveItems.length} personal items to Studio.`);
			return res.json(liveItems);
			
		} else {
			// 4. ROBLOX RATE LIMITED US! (API Failure)
			// Instead of sending 0, check if we have an old, stale cache we can use as a backup.
			if (inventoryCache.has(userId)) {
				const staleData = inventoryCache.get(userId).items;
				console.log(`⚠️ API Blocked! Serving ${staleData.length} BACKUP items to Studio.`);
				return res.json(staleData);
			}
			
			// 5. Total failure and no backup exists. Send empty array.
			console.log(`❌ Sent 0 personal items to Studio.`);
			return res.json([]);
		}
	});

	// =============================
	// ROOT
	// =============================
	app.get("/", (req, res) => {
		res.send("BMT & Donation Backend Running");
	});

	// =============================
	// START SERVER
	// =============================
	const PORT = process.env.PORT || 3000;

	app.listen(PORT, () => {
		console.log("🚀 Running on port", PORT);
	});
}

start().catch(console.error);
