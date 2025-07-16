// Don't silently swallow unhandled rejections
process.on("unhandledRejection", (e) => {
	throw e;
});

// Basic chai setup without extensions for now
const { should } = require("chai");
should();

console.log("Basic test setup completed");