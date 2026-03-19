#!/bin/bash

# Build script for Profanity Filter extension

set -e

echo "Building Profanity Filter extension..."

# Clean dist directory
rm -rf dist
mkdir -p dist/icons
mkdir -p dist/styles

# Install esbuild if not present
if ! command -v npx &> /dev/null; then
    echo "npx is required"
    exit 1
fi

# Bundle TypeScript files with esbuild
echo "Bundling background script..."
npx esbuild src/background/index.ts --bundle --outfile=dist/background.js --format=esm --platform=browser --target=firefox102 --external:firefo-webext-browser

echo "Bundling content script..."
npx esbuild src/content/index.ts --bundle --outfile=dist/content.js --format=iife --platform=browser --target=firefox102

echo "Bundling options script..."
npx esbuild src/options/index.ts --bundle --outfile=dist/options.js --format=iife --platform=browser --target=firefox102

echo "Bundling popup script..."
npx esbuild src/popup/index.ts --bundle --outfile=dist/popup.js --format=iife --platform=browser --target=firefox102

# Copy static files
echo "Copying static files..."
cp public/manifest.json dist/
cp src/options/options.html dist/
cp src/popup/popup.html dist/
cp src/options/privacy.html dist/
cp src/options/user-guide.html dist/
cp src/styles/options.css dist/styles/
cp src/styles/popup.css dist/styles/

# Create placeholder PNG icons using base64
echo "Creating placeholder icons..."

# 16x16 purple square icon (simple base64 encoded PNG)
# This creates a simple purple square PNG
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
    
    # PNG signature
    signature = b'\\x89PNG\\r\\n\\x1a\\n'
    
    # IHDR chunk
    ihdr_data = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    ihdr = png_chunk(b'IHDR', ihdr_data)
    
    # IDAT chunk (raw pixel data)
    raw_data = b''
    for y in range(height):
        raw_data += b'\\x00'  # Filter byte
        for x in range(width):
            raw_data += bytes(color)  # RGB
    
    compressed = zlib.compress(raw_data, 9)
    idat = png_chunk(b'IDAT', compressed)
    
    # IEND chunk
    iend = png_chunk(b'IEND', b'')
    
    return signature + ihdr + idat + iend

# Purple color RGB
purple = (74, 20, 140)  # #4a148c

for size in [16, 32, 48, 128]:
    png_data = create_png(size, size, purple)
    with open(f'dist/icons/icon-{size}.png', 'wb') as f:
        f.write(png_data)
    print(f'Created icon-{size}.png')
"

echo ""
echo "Build complete! Output in dist/"
echo ""
echo "Files in dist:"
ls -la dist/
ls -la dist/icons/
echo ""
echo "To load in Firefox:"
echo "1. Open Firefox and go to about:debugging"
echo "2. Click 'This Firefox' in the left sidebar"
echo "3. Click 'Load Temporary Add-on'"
echo "4. Select the manifest.json file in the dist folder"