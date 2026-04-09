import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['tests/**/*.test.ts'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      include: ['src/lib/**/*.ts'],
    },
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  define: {
    __DEV__: true,
  },
});