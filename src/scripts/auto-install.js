const { execSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");

function hashFile(path) {
  if (!fs.existsSync(path)) return "";
  return crypto.createHash("md5").update(fs.readFileSync(path)).digest("hex");
}

const pkgHashFile = ".packagehash";

const currentHash = hashFile("package.json");
let oldHash = "";

if (fs.existsSync(pkgHashFile)) {
  oldHash = fs.readFileSync(pkgHashFile, "utf8");
}

if (currentHash !== oldHash) {
  console.log("📦 Detected new dependencies... Installing...");
  execSync("npm install", { stdio: "inherit" });

  // Update hash file
  fs.writeFileSync(pkgHashFile, currentHash);
} else {
  console.log("👍 No new packages. Continuing...");
}
