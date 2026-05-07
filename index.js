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
// LICENSE (STRICT PLACE ID LOCK)
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
// START ROBLOX
// =============================
async function start() {
	await rbx.setCookie(COOKIE);
	console.log("✅ Logged into Roblox backend");
	
	// =============================
	// CHECK KEY (SECURE STARTUP CHECK)
	// =============================
	app.get("/checkkey", (req, res) => {
		const key = req.query.key;
		const placeId = Number(req.query.placeid);

		// Now this actively locks/verifies the placeId immediately on server start
		const result = validateKey(key, placeId);
		
		if (!result.ok) {
			return res.status(403).json({ ok: false, error: "INVALID_LICENSE" });
		}

		return res.json({ ok: true, message: "API Key Valid & Locked to Place" });
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
	// ROOT
	// =============================
	app.get("/", (req, res) => {
		res.send("BMT Backend Running");
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
