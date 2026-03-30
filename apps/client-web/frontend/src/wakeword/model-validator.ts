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

  // Load the trained model for this keyword
  const { getOwwSessions } = await import('./wakeword-manager');
  const { melSession, embSession } = getOwwSessions();
  const ort = (window as any).ort;

  if (!melSession || !embSession) {
    throw new Error('OWW sessions not initialized');
  }

  // Process each sample
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    const startTime = performance.now();

    try {
      // Extract features from the sample
      const { extractBatchFeatures } = await import('./personalization-features');
      const features = await extractBatchFeatures([sample.audioData], melSession, embSession, ort);

      // Run the classifier on the features
      // The classifier expects 16-frame sequences
      const sequences: Float32Array[] = [];
      for (let j = 0; j < features[0].length - 15; j++) {
        const seq = new Float32Array(16 * 96);
        for (let k = 0; k < 16; k++) {
          seq.set(features[0][j + k], k * 96);
        }
        sequences.push(seq);
      }

      // For now, use a simple threshold-based detection
      // In production, this would load and run the trained classifier
      const avgEnergy = sequences.reduce((sum, seq) => {
        let energy = 0;
        for (let j = 0; j < seq.length; j++) energy += seq[j] * seq[j];
        return sum + energy / seq.length;
      }, 0) / sequences.length;

      const detected = avgEnergy > 0.1; // Simplified detection
      const latencyMs = performance.now() - startTime;

      validator.addResult({
        sampleId: sample.id,
        detected,
        confidence: Math.min(avgEnergy * 2, 1.0),
        latencyMs,
      });
    } catch (e) {
      // If detection fails, record as not detected
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