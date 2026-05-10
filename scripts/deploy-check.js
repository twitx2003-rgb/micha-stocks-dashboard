import { readFile } from "node:fs/promises";

const requiredFiles = [
  "server.js",
  "package.json",
  "package-lock.json",
  "Dockerfile",
  "render.yaml",
  "railway.json",
  "config.json",
  "public/index.html",
  "public/app.js",
  "public/styles.css"
];

for (const file of requiredFiles) {
  await readFile(file);
}

const config = JSON.parse(await readFile("config.json", "utf8"));
if (!config.youtube?.channelId) {
  throw new Error("Missing youtube.channelId in config.json");
}

console.log("Deploy check passed");
