#!/bin/bash

# Build script for Profanity Filter extension
# Usage:
#   ./build.sh           - Build for development (loads temporarily in Firefox)
#   ./build.sh prod      - Build for production (creates XPI for distribution)
#   ./build.sh package   - Same as 'prod' - creates XPI package

set -e

MODE="${1:-dev}"

echo "Building Profanity Filter extension (${MODE} mode)..."

# Set __DEV__ define based on build mode
if [ "$MODE" = "prod" ] || [ "$MODE" = "package" ]; then
    DEV_DEFINE="__DEV__=false"
    ESBUILD_MINIFY="--minify"
else
    DEV_DEFINE="__DEV__=true"
    ESBUILD_MINIFY=""
fi

# Clean dist directory
rm -rf dist
mkdir -p dist/icons
mkdir -p dist/styles
mkdir -p dist/page-scripts

# Bundle TypeScript files with esbuild
echo "Bundling background script..."
npm exec -- esbuild src/background/index.ts --bundle --outfile=dist/background.js --format=esm --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY

echo "Bundling content script..."
npm exec -- esbuild src/content/index.ts --bundle --outfile=dist/content.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY

echo "Bundling options script..."
npm exec -- esbuild src/options/index.ts --bundle --outfile=dist/options.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY

echo "Bundling popup script..."
npm exec -- esbuild src/popup/index.ts --bundle --outfile=dist/popup.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY

echo "Bundling page-scripts..."
npm exec -- esbuild src/page-scripts/plutotv-injected.ts --bundle --outfile=dist/page-scripts/plutotv-injected.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY
npm exec -- esbuild src/page-scripts/youtube-injected.ts --bundle --outfile=dist/page-scripts/youtube-injected.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY
npm exec -- esbuild src/page-scripts/fmovies-injected.ts --bundle --outfile=dist/page-scripts/fmovies-injected.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY
npm exec -- esbuild src/page-scripts/lookmovie-injected.ts --bundle --outfile=dist/page-scripts/lookmovie-injected.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY
npm exec -- esbuild src/page-scripts/jellyfin-injected.ts --bundle --outfile=dist/page-scripts/jellyfin-injected.js --format=iife --platform=browser --target=firefox113 --define:$DEV_DEFINE $ESBUILD_MINIFY

# Copy HTML files
echo "Copying HTML files..."
cp src/options/options.html dist/
cp src/popup/popup.html dist/
cp src/options/privacy.html dist/ 2>/dev/null || true
cp src/options/user-guide.html dist/ 2>/dev/null || true

# Copy CSS files
echo "Copying CSS files..."
cp src/styles/options.css dist/
cp src/styles/popup.css dist/

# Copy icons
echo "Copying icons..."
if [ -f public/icons/icon-16.png ]; then
    cp public/icons/icon-16.png dist/icons/
    cp public/icons/icon-32.png dist/icons/
    cp public/icons/icon-48.png dist/icons/
    cp public/icons/icon-128.png dist/icons/
else
    echo "Creating placeholder icons..."
    python3 -c "
from base64 import b64decode
import struct
import zlib

def create_png(width, height, color):
    def png_chunk(chunk_type, data):
        chunk_len = len(data)
        chunk = chunk_type + data
        crc = zlib.crc32(chunk) & 0xffffffff
        return struct.pack('>I', chunk_len) + chunk + struct.pack('>I', crc)

    signature = b'\\x89PNG\\r\\n\\x1a\\n'
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = png_chunk(b'IHDR', ihdr_data)
    raw_data = b''
    for y in range(height):
        raw_data += b'\\x00'
        for x in range(width):
            raw_data += bytes(color)
    compressed = zlib.compress(raw_data, 9)
    idat = png_chunk(b'IDAT', compressed)
    iend = png_chunk(b'IEND', b'')
    return signature + ihdr + idat + iend

purple = (74, 20, 140)
for size in [16, 32, 48, 128]:
    png_data = create_png(size, size, purple)
    with open(f'dist/icons/icon-{size}.png', 'wb') as f:
        f.write(png_data)
"
fi

# Copy appropriate manifest based on mode
if [ "$MODE" = "prod" ] || [ "$MODE" = "package" ]; then
    echo "Using production manifest..."
    cp public/manifest.prod.json dist/manifest.json
else
    echo "Using development manifest..."
    cp public/manifest.dev.json dist/manifest.json
fi

# Copy words.json if it exists
if [ -f words.json ]; then
    cp words.json dist/
fi

echo ""
echo "Build complete! Output in dist/"
echo ""
echo "Files in dist:"
ls -la dist/
ls -la dist/icons/
echo ""

if [ "$MODE" = "prod" ] || [ "$MODE" = "package" ]; then
    echo "Creating XPI package..."
    mkdir -p artifacts
    
    # Get version from manifest
    VERSION=$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' dist/manifest.json | cut -d'"' -f4)
    
    # Create XPI (just a zip file with .xpi extension)
    cd dist
    zip -r ../artifacts/ffprofanity-${VERSION}.xpi . -x "*.map" -x "*.DS_Store"
    cd ..
    
    echo ""
    echo "XPI package created: artifacts/ffprofanity-${VERSION}.xpi"
    echo ""
    echo "To install in Firefox:"
    echo "1. Go to about:addons"
    echo "2. Click the gear icon and select 'Install Add-on From File'"
    echo "3. Select the XPI file from the artifacts folder"
    echo ""
    echo "NOTE: For unsigned extensions, you need to:"
    echo "  - Set xpinstall.signatures.required=false in about:config (dev builds only)"
    echo "  - Or sign the extension at https://addons.mozilla.org/developers/"
else
    echo "To load in Firefox (development):"
    echo "1. Open Firefox and go to about:debugging"
    echo "2. Click 'This Firefox' in the left sidebar"
    echo "3. Click 'Load Temporary Add-on'"
    echo "4. Select the manifest.json file in the dist folder"
fi