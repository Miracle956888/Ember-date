set -e
cd /app
test -s public/css/app.css || { echo "public/css/app.css missing or empty in the image"; exit 1; }
echo "app.css: $(wc -c < public/css/app.css) bytes"
node -e '
  const fs = require("fs");
  const deps = JSON.parse(fs.readFileSync("package.json", "utf8")).dependencies;
  const names = Object.keys(deps);
  const missing = names.filter((d) => !fs.existsSync("node_modules/" + d + "/package.json"));
  for (const d of names) {
    const v = JSON.parse(fs.readFileSync("node_modules/" + d + "/package.json", "utf8")).version;
    console.log("  " + d + " " + v);
  }
  if (missing.length) {
    console.error("not installed in the runtime image: " + missing.join(", "));
    process.exit(1);
  }
  console.log(names.length + " direct dependencies resolved");
  const dev = ["eslint", "tailwindcss", "nodemon", "concurrently", "socket.io-client"].filter((d) => fs.existsSync("node_modules/" + d));
  if (dev.length) {
    console.error("devDependencies leaked into the runtime image: " + dev.join(", "));
    process.exit(1);
  }
  console.log("no devDependencies in the runtime image");
'
echo "node_modules entries: $(ls node_modules | wc -l)"
echo "image contents OK"
