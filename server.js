const express = require("express");

const app = express();

app.get("/roblox-passes", async (req, res) => {
	const userId = String(req.query.userId || "");

	if (userId === "5364064") {
		return res.json({
			success: true,
			items: [
				{ PassId: 1460493628 },
				{ PassId: 110542510 },
				{ PassId: 1106637191 },
				{ PassId: 1107534668 }
			]
		});
	}

	return res.json({
		success: true,
		items: []
	});
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
	console.log("Listening on port", PORT);
});
