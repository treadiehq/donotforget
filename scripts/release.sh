#!/bin/bash
set -e

cd "$(dirname "$0")/../app"

VERSION=$(node -p "require('./package.json').version")
DMG="release/Do Not Forget-${VERSION}-arm64.dmg"
GIST_ID="7c141e24257a278783e5651b74f3f7b8"
REPO="treadiehq/donotforget"

echo "==> Building and packaging v${VERSION}..."
bun run package

echo "==> Pushing code..."
cd ..
git add -A
git commit -m "v${VERSION}" --allow-empty
git push

echo "==> Creating GitHub release v${VERSION}..."
gh release create "v${VERSION}" \
  "app/${DMG}" \
  --repo "${REPO}" \
  --title "v${VERSION}" \
  --notes "Release v${VERSION}"

RELEASE_URL="https://github.com/${REPO}/releases/tag/v${VERSION}"
echo "==> Updating version gist..."
echo "{\"version\": \"${VERSION}\", \"download\": \"${RELEASE_URL}\"}" | \
  gh gist edit "${GIST_ID}" -f version.json -

echo ""
echo "Done! v${VERSION} released at ${RELEASE_URL}"
