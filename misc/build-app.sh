#!/bin/bash -e
#
# Build release version of app
#
cd "$(dirname "$0")/.."
source misc/util.sh
rootdir=$PWD

rm -rf docs/app.* docs/resources.* docs/source-map-*.wasm

spawn_monaco_build "$rootdir/docs" && echo "monaco is up-to-date" || true

bash misc/build-app.pre.sh "docs"

echo; echo
echo "## Building ./src/app -> ./docs"
echo "###########################################"

pushd src/app > /dev/null
vite build

wait
popd > /dev/null

# for some reason, the webpack CopyPlugin fails, so we do it manually:
SOURCE_MAP_VERSION=$(node -p 'require("source-map/package.json").version')
cp -f node_modules/source-map/lib/mappings.wasm \
      docs/source-map-${SOURCE_MAP_VERSION}-mappings.wasm

echo "✓ done"
