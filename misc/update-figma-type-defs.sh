#!/bin/bash -e

cd "$(dirname "$0")/.."
ni="./node_modules/.bin/ni"

$ni install -D @figma/plugin-typings@latest
version=$(npm view @figma/plugin-typings version)

SRC=./node_modules/@figma/plugin-typings/plugin-api.d.ts
OUT=build/figma.d.ts

mkdir -p build

echo "/**
 * @figma/plugin-typings@$version
 */
" > $OUT
# echo "declare global {" >> $OUT
cat $SRC >> $OUT
echo "

export {}
" >> $OUT

cp $OUT src/app/code/figma.d.ts
echo "wrote src/app/code/figma.d.ts"

cp $OUT src/figma-plugin/figma.d.ts
echo "wrote src/figma-plugin/figma.d.ts"

