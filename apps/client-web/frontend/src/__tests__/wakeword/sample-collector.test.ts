// apps/client-web/frontend/src/__tests__/wakeword/sample-collector.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SampleCollector,
  validateSample,
  SAMPLE_RATE,
  MIN_DURATION_S,
  MAX_DURATION_S,
  MIN_RMS,
} from '../../wakeword/sample-collector';

describe('sample-collector', () => {
  describe('validateSample', () => {
    it('should accept valid sample', () => {
      // 1 second of audio with reasonable volume
      const audio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5; // Sine wave
      }

      const result = validateSample(audio);
      expect(result.valid).toBe(true);
      expect(result.duration).toBeCloseTo(1.0, 1);
    });

    it('should reject too short sample', () => {
      const audio = new Float32Array(SAMPLE_RATE * 0.2); // 0.2 seconds
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5;
      }

      const result = validateSample(audio);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('short');
    });

    it('should reject too quiet sample', () => {
      const audio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.001; // Very quiet
      }

      const result = validateSample(audio);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('quiet');
    });
  });

  describe('SampleCollector', () => {
    let collector: SampleCollector;

    beforeEach(() => {
      collector = new SampleCollector();
    });

    it('should start with empty samples', () => {
      expect(collector.getSamples().length).toBe(0);
    });

    it('should add valid sample', () => {
      const audio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5;
      }

      const result = collector.addSample(audio, 'mic');
      expect(result).toBe(true);
      expect(collector.getSamples().length).toBe(1);
    });

    it('should reject invalid sample', () => {
      const audio = new Float32Array(SAMPLE_RATE * 0.1); // Too short
      const result = collector.addSample(audio, 'mic');
      expect(result).toBe(false);
      expect(collector.getSamples().length).toBe(0);
    });

    it('should remove sample by id', () => {
      const audio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5;
      }

      collector.addSample(audio, 'mic');
      const samples = collector.getSamples();
      expect(samples.length).toBe(1);

      collector.removeSample(samples[0].id);
      expect(collector.getSamples().length).toBe(0);
    });

    it('should clear all samples', () => {
      const audio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin(i * 0.01) * 0.5;
      }

      collector.addSample(audio, 'mic');
      collector.addSample(audio, 'mic');
      expect(collector.getSamples().length).toBe(2);

      collector.clear();
      expect(collector.getSamples().length).toBe(0);
    });

    it('should count valid samples only', () => {
      const validAudio = new Float32Array(SAMPLE_RATE);
      for (let i = 0; i < validAudio.length; i++) {
        validAudio[i] = Math.sin(i * 0.01) * 0.5;
      }

      const invalidAudio = new Float32Array(SAMPLE_RATE * 0.1); // Too short

      collector.addSample(validAudio, 'mic');
      collector.addSample(invalidAudio, 'mic');

      expect(collector.getValidCount()).toBe(1);
    });
  });
});