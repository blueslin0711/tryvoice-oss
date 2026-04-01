// apps/client-web/frontend/src/wakeword/model-validator.ts
/**
 * Model validation for trained wakeword models.
 *
 * Provides realtime testing and batch validation capabilities.
 */

import { createLogger } from '../logging/logger';

const log = createLogger('wakeword.model-validator');

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface ValidationResult {
  sampleId: string;
  detected: boolean;
  confidence: number;
  latencyMs: number;
}

export interface ValidationStats {
  total: number;
  detected: number;
  successRate: number;
  avgLatencyMs: number;
  avgConfidence: number;
}

// ──────────────────────────────────────────────
// Model Validator
// ──────────────────────────────────────────────

export class ModelValidator {
  private results: ValidationResult[] = [];
  private acceptanceThreshold = 0.8; // 80% success rate required

  addResult(result: ValidationResult): void {
    this.results.push(result);
    log.info('Added validation result', {
      sampleId: result.sampleId,
      detected: result.detected,
      confidence: result.confidence,
    });
  }

  getResults(): ValidationResult[] {
    return [...this.results];
  }

  clear(): void {
    this.results = [];
  }

  getStats(): ValidationStats {
    if (this.results.length === 0) {
      return {
        total: 0,
        detected: 0,
        successRate: 0,
        avgLatencyMs: 0,
        avgConfidence: 0,
      };
    }

    const detected = this.results.filter(r => r.detected).length;
    const totalLatency = this.results.reduce((sum, r) => sum + r.latencyMs, 0);
    const totalConfidence = this.results.reduce((sum, r) => sum + r.confidence, 0);

    return {
      total: this.results.length,
      detected,
      successRate: detected / this.results.length,
      avgLatencyMs: totalLatency / this.results.length,
      avgConfidence: totalConfidence / this.results.length,
    };
  }

  isAcceptable(): boolean {
    const stats = this.getStats();
    return stats.successRate >= this.acceptanceThreshold;
  }

  setAcceptanceThreshold(threshold: number): void {
    this.acceptanceThreshold = Math.max(0, Math.min(1, threshold));
  }
}

// ──────────────────────────────────────────────
// Batch Validation
// ──────────────────────────────────────────────

export async function validateBatchSamples(
  samples: Array<{ id: string; audioData: Float32Array }>,
  keyword: string,
  onProgress?: (current: number, total: number) => void,
): Promise<ValidationResult[]> {
  const validator = new ModelValidator();

  // Process each sample by calling backend API
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const startTime = performance.now();

    try {
      // Send audio to backend for detection using trained model
      const response = await fetch('/wakeword/detect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: keyword,
          audio: Array.from(sample.audioData),
        }),
      });

      const latencyMs = performance.now() - startTime;

      if (response.ok) {
        const result = await response.json();
        validator.addResult({
          sampleId: sample.id,
          detected: result.detected || false,
          confidence: result.confidence || 0,
          latencyMs,
        });
      } else {
        // API error, record as not detected
        validator.addResult({
          sampleId: sample.id,
          detected: false,
          confidence: 0,
          latencyMs,
        });
      }
    } catch (e) {
      log.warn('Batch validation failed for sample', {
        sampleId: sample.id,
        error: String(e),
      });
      validator.addResult({
        sampleId: sample.id,
        detected: false,
        confidence: 0,
        latencyMs: performance.now() - startTime,
      });
    }

    if (onProgress) {
      onProgress(i + 1, samples.length);
    }
  }

  return validator.getResults();
}