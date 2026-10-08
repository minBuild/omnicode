import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          include: ['packages/*/test/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // 웹 화면 DOM 테스트 (handoff D6): jsdom + React Testing Library
        extends: true,
        plugins: [react()],
        test: {
          name: 'web-dom',
          include: ['packages/web/test/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['packages/web/test/setup-dom.ts'],
        },
      },
    ],
  },
});
