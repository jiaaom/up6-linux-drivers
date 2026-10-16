#!/bin/sh
# Screenshot the panel UI headless: tools/shoot.sh <url> <out.png> [steps.js]
# (see shoot.js; needs `npm ci` in panel/app for the bundled Electron)
here=$(dirname "$0")
exec "$here/../app/node_modules/electron/dist/electron" \
  --ozone-platform=headless --ozone-override-screen-size=1200,1800 \
  --no-sandbox --disable-gpu "$here/shoot.js" "$@"
