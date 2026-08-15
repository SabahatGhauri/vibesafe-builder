// Local dev entry point. Vercel deployment uses api/index.js instead —
// both share the same app defined in lib/app.js.
const app = require("./lib/app");

const PORT = process.env.PORT || 3111;
app.listen(PORT, () => console.log(`VibeSafe Builder running on http://localhost:${PORT}`));
