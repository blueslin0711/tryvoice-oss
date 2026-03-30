// apps/client-web/frontend/src/__tests__/wakeword/model-validator.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModelValidator } from '../../wakeword/model-validator';

describe('model-validator', () => {
  describe('ModelValidator', () => {
    it('should create validator instance', () => {
      const validator = new ModelValidator();
      expect(validator).toBeDefined();
    });

    it('should track validation results', () => {
      const validator = new ModelValidator();

      validator.addResult({
        sampleId: 'test_1',
        detected: true,
        confidence: 0.95,
        latencyMs: 100,
      });

      const results = validator.getResults();
      expect(results.length).toBe(1);
      expect(results[0].detected).toBe(true);
    });

    it('should calculate success rate', () => {
      const validator = new ModelValidator();

      validator.addResult({ sampleId: '1', detected: true, confidence: 0.9, latencyMs: 100 });
      validator.addResult({ sampleId: '2', detected: true, confidence: 0.8, latencyMs: 110 });
      validator.addResult({ sampleId: '3', detected: false, confidence: 0.3, latencyMs: 120 });
      validator.addResult({ sampleId: '4', detected: true, confidence: 0.85, latencyMs: 105 });

      const stats = validator.getStats();
      expect(stats.total).toBe(4);
      expect(stats.detected).toBe(3);
      expect(stats.successRate).toBeCloseTo(0.75, 2);
    });

    it('should clear results', () => {
      const validator = new ModelValidator();

      validator.addResult({ sampleId: '1', detected: true, confidence: 0.9, latencyMs: 100 });
      expect(validator.getResults().length).toBe(1);

      validator.clear();
      expect(validator.getResults().length).toBe(0);
    });

    it('should check if success rate is acceptable', () => {
      const validator = new ModelValidator();

      // 80% success rate
      validator.addResult({ sampleId: '1', detected: true, confidence: 0.9, latencyMs: 100 });
      validator.addResult({ sampleId: '2', detected: true, confidence: 0.8, latencyMs: 110 });
      validator.addResult({ sampleId: '3', detected: false, confidence: 0.3, latencyMs: 120 });
      validator.addResult({ sampleId: '4', detected: true, confidence: 0.85, latencyMs: 105 });
      validator.addResult({ sampleId: '5', detected: true, confidence: 0.88, latencyMs: 108 });

      expect(validator.isAcceptable()).toBe(true);
    });

    it('should detect unacceptable success rate', () => {
      const validator = new ModelValidator();

      // 60% success rate
      validator.addResult({ sampleId: '1', detected: true, confidence: 0.9, latencyMs: 100 });
      validator.addResult({ sampleId: '2', detected: false, confidence: 0.3, latencyMs: 110 });
      validator.addResult({ sampleId: '3', detected: false, confidence: 0.3, latencyMs: 120 });
      validator.addResult({ sampleId: '4', detected: true, confidence: 0.85, latencyMs: 105 });
      validator.addResult({ sampleId: '5', detected: false, confidence: 0.2, latencyMs: 108 });

      expect(validator.isAcceptable()).toBe(false);
    });
  });
});