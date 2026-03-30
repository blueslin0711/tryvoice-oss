// apps/client-web/frontend/src/__tests__/wakeword/training-tool.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  TrainingToolState,
  createInitialState,
  validateKeyword,
  canProceedToSamples,
  canProceedToTraining,
} from '../../wakeword/training-tool';

describe('training-tool', () => {
  describe('createInitialState', () => {
    it('should create initial state with correct defaults', () => {
      const state = createInitialState();
      expect(state.stage).toBe('keyword');
      expect(state.keyword).toBe('');
      expect(state.keywordValid).toBe(false);
      expect(state.micSamples).toEqual([]);
      expect(state.targetSampleCount).toBe(20);
    });
  });

  describe('validateKeyword', () => {
    it('should accept valid keywords', () => {
      expect(validateKeyword('小助手')).toBe(true);
      expect(validateKeyword('大橘大橘')).toBe(true);
      expect(validateKeyword('你好')).toBe(true);
    });

    it('should reject empty keywords', () => {
      expect(validateKeyword('')).toBe(false);
    });

    it('should reject too short keywords', () => {
      expect(validateKeyword('啊')).toBe(false);
    });

    it('should reject too long keywords', () => {
      expect(validateKeyword('这是一个非常长的唤醒词测试')).toBe(false);
    });

    it('should reject keywords with special characters', () => {
      expect(validateKeyword('小助手!')).toBe(false);
      expect(validateKeyword('hello@world')).toBe(false);
    });
  });

  describe('canProceedToSamples', () => {
    it('should allow proceeding with valid keyword', () => {
      const state = createInitialState();
      state.keyword = '小助手';
      state.keywordValid = true;
      expect(canProceedToSamples(state)).toBe(true);
    });

    it('should block proceeding with invalid keyword', () => {
      const state = createInitialState();
      state.keyword = '';
      state.keywordValid = false;
      expect(canProceedToSamples(state)).toBe(false);
    });
  });

  describe('canProceedToTraining', () => {
    it('should allow proceeding with enough samples', () => {
      const state = createInitialState();
      state.micSamples = Array(10).fill(null).map((_, i) => ({
        id: `sample_${i}`,
        source: 'mic' as const,
        audioData: new Float32Array(16000),
        duration: 1,
        rms: 0.02,
        valid: true,
      }));
      expect(canProceedToTraining(state)).toBe(true);
    });

    it('should block proceeding with too few samples', () => {
      const state = createInitialState();
      state.micSamples = Array(3).fill(null).map((_, i) => ({
        id: `sample_${i}`,
        source: 'mic' as const,
        audioData: new Float32Array(16000),
        duration: 1,
        rms: 0.02,
        valid: true,
      }));
      expect(canProceedToTraining(state)).toBe(false);
    });
  });
});