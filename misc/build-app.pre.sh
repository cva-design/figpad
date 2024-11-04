#!/bin/bash -e
cd "$(dirname "$0")/.."

outdir=docs
if [[ "$1" != "" ]]; then outdir=$1 ; fi

mkdir -p "$outdir"

echo
echo "## Building tslibs"
echo "###########################################"
nr build:tslibs docs

echo; echo
echo "## Building worker"
echo "###########################################"
nr build:worker

wait
