// Vercel serverless entry point. An Express app is itself a valid
// (req, res) handler, so exporting it directly works with @vercel/node.
module.exports = require("../lib/app");
