#!/bin/bash
# Download the Tartu road network, Tartu city bus route relations (network="Tartu linn")
# and turn restrictions from OpenStreetMap via Overpass. Output: raw/osm.json
set -e
cd "$(dirname "$0")/.."
mkdir -p raw
for i in 1 2 3 4 5 6; do
  curl -s -m 400 -A "tartu-nav-builder/0.1" --data-urlencode data@build/osm_query.overpassql \
    https://overpass-api.de/api/interpreter -o raw/osm.json.tmp
  if python3 -c "import json,sys; d=json.load(open('raw/osm.json.tmp')); sys.exit(0 if len(d['elements'])>1000 else 1)" 2>/dev/null; then
    mv raw/osm.json.tmp raw/osm.json; echo "saved raw/osm.json"; exit 0
  fi
  echo "Overpass busy, retrying in $((i*20)) s ..."; sleep $((i*20))
done
echo "Overpass download failed" >&2; exit 1
