#!/bin/bash
# Publish the contents of web/ to GitHub Pages (branch gh-pages). Commit your changes on main first.
set -e
cd "$(dirname "$0")"
git push origin "$(git subtree split --prefix web HEAD)":refs/heads/gh-pages --force
echo "Deployed. It can take a minute before the site updates."
