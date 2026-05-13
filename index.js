const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

const ROBLOX_API_KEY = process.env.ROBLOX_API_KEY; 

if (!ROBLOX_API_KEY) {
	console.error("❌ Missing ROBLOX_API_KEY environment variable");
	process.exit(1);
}

// =============================
// CUSTOMER DATABASE (WHITELIST)
// =============================
const whitelistData = [
    { 
        groupname: "SeintSlavx Main Group", 
        groupid: 32363103, // Matches Admin.Core.GroupID
        groupsecretkey: "9e2c7b4f1a6d0e8f5c3b9a4d7e1f2c8b6a5", // Matches your SetupMEV2 APIKeyV2
        Suspended: false 
    }
];

// =============================
// SECURE STARTUP CHECK
// =============================
app.get("/checkkey", (req, res) => {
    const providedKey = req.headers["x-auth-key"];
    const groupId = Number(req.query.groupid);

    const customer = whitelistData.find(c => c.groupid === groupId);

    if (!customer || customer.groupsecretkey !== providedKey) {
        return res.status(403).json({ ok: false, error: "INVALID_LICENSE" });
    }

    if (customer.Suspended) {
        return res.status(403).json({ ok: false, error: "SUBSCRIPTION_SUSPENDED" });
    }

    return res.json({ ok: true, message: "API Key Valid & Connected" });
});

// =============================
// SETRANK ENDPOINT (OPEN CLOUD)
// =============================
app.post("/setrank", async (req, res) => {
    const providedKey = req.headers["x-auth-key"];
    const { userId, roleId, groupId } = req.body; 

    // 1. Validation & Security
    const customer = whitelistData.find(c => c.groupid === Number(groupId));

    if (!customer) return res.status(403).json({ ok: false, error: "GROUP_NOT_WHITELISTED" });
    if (customer.groupsecretkey !== providedKey) return res.status(401).json({ ok: false, error: "INVALID_SECRET_KEY" });
    if (customer.Suspended) return res.status(403).json({ ok: false, error: "SUBSCRIPTION_SUSPENDED" });

    try {
        // 2. Rank Translation (0-255 to Role ID)
        const rolesRes = await axios.get(`https://groups.roblox.com/v1/groups/${groupId}/roles`);
        const targetRole = rolesRes.data.roles.find(r => r.rank === roleId);

        if (!targetRole) return res.status(404).json({ ok: false, error: "RANK_NOT_FOUND" });

        // 3. Execute Open Cloud Rank Change
        const url = `https://apis.roblox.com/cloud/v2/groups/${groupId}/memberships/${userId}`;
        await axios.patch(url, 
            { role: `groups/${groupId}/roles/${targetRole.id}` }, 
            { headers: { "x-api-key": ROBLOX_API_KEY, "Content-Type": "application/json" } }
        );

        console.log(`✅ Success: User ${userId} ranked up in Group ${groupId}`);
        return res.json({ ok: true, message: `Ranked to ${targetRole.name}` });

    } catch (error) {
        console.error("❌ Roblox API Error:", error.response?.data || error.message);
        return res.status(500).json({ ok: false, error: "ROBLOX_API_ERROR" });
    }
});

// Root route hides passwords
app.get("/", (req, res) => {
    const publicList = whitelistData.map(c => ({ groupname: c.groupname, groupid: c.groupid, Suspended: c.Suspended }));
    res.json(publicList);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Open Cloud API Running on port ${PORT}`));
