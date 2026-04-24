#!/bin/bash
set -e
cd /Users/warrenmatthews/.openclaw/workspace/projects/fresh-coverage
node src/report.js
cp reports/index.html docs/index.html
git add -A
git commit -m "Project Summary: Phase 2/3 milestones, updated stats + full ZIP probe launched"
git push
