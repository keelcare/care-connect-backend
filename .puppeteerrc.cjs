const { join } = require("path");

/**
 * Keep the downloaded Chrome inside the project directory.
 *
 * Puppeteer defaults to `$HOME/.cache/puppeteer`. On Render's native Node
 * runtime that resolves to `/opt/render/.cache/puppeteer`, which is *outside*
 * `/opt/render/project/src` — only the project directory survives from the build
 * step into the running service, so the browser downloaded at build time is gone
 * by the time the app starts and Puppeteer reports "Could not find Chrome".
 *
 * Putting the cache under the project root makes the browser part of the build
 * output, so it is simply there at runtime. This also works unchanged locally
 * and in a container, so there is nothing platform-specific in the app itself.
 *
 * @type {import('puppeteer').Configuration}
 */
module.exports = {
  cacheDirectory: join(__dirname, ".cache", "puppeteer"),
};
