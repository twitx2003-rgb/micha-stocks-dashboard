import { networkInterfaces } from "node:os";

const port = Number(process.env.PORT || 4173);
const urls = Object.values(networkInterfaces())
  .flat()
  .filter((item) => item && item.family === "IPv4" && !item.internal)
  .map((item) => `http://${item.address}:${port}`);

console.log("Computer URL: http://localhost:" + port);
if (urls.length) {
  console.log("Phone URL on the same Wi-Fi:");
  for (const url of urls) console.log(url);
} else {
  console.log("No Wi-Fi/LAN address was found.");
}
