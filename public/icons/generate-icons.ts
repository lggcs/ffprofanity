/**
 * Generate placeholder icon SVGs and icons
 */

// Simple icon generator - creates PNG-like placeholder data
// In production, these would be proper PNG files

const ICON_SIZES = [16, 32, 48, 128];

function createIconSVG(size: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#4a148c" rx="4"/>
  <text x="50%" y="50%" fill="white" font-family="Arial" font-size="${size * 0.6}" font-weight="bold" text-anchor="middle" dominant-baseline="central">
    F
  </text>
</svg>`;
}

console.log('Icon placeholders generated');
console.log('Size:', ICON_SIZES);

// Export for use in build process
export { createIconSVG, ICON_SIZES };