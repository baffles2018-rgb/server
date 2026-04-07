const express = require("express");

const app = express();

app.get("/roblox-passes", async (req, res) => {
	const userId = String(req.query.userId || "");

	if (userId === "5364064") {
		return res.json({
			success: true,
			items: [
				{ PassId: 1460493628 }, // wat
				{ PassId: 110542510 },  // do it
				{ PassId: 1106637191 }  // do it if ur bad
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
