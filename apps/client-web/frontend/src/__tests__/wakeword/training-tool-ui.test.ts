// apps/client-web/frontend/src/__tests__/wakeword/training-tool-ui.test.ts
import { describe, it, expect } from 'vitest';

describe('training-tool-ui', () => {
  describe('UI helper functions', () => {
    it('should export createOverlay function', async () => {
      const { createOverlay } = await import('../../wakeword/training-tool-ui');
      expect(typeof createOverlay).toBe('function');
    });

    it('should export removeOverlay function', async () => {
      const { removeOverlay } = await import('../../wakeword/training-tool-ui');
      expect(typeof removeOverlay).toBe('function');
    });

    it('should export stage render functions', async () => {
      const ui = await import('../../wakeword/training-tool-ui');
      expect(typeof ui.renderKeywordInput).toBe('function');
      expect(typeof ui.renderSampleCollection).toBe('function');
      expect(typeof ui.renderTraining).toBe('function');
      expect(typeof ui.renderValidation).toBe('function');
      expect(typeof ui.renderInstall).toBe('function');
    });
  });
});