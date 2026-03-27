/**
 * Offline feature extraction for wakeword personalization.
 * Reuses the mel + embedding ONNX sessions from wakeword-manager.
 * Pipeline must exactly match _owwProcessChunk in wakeword-manager.ts.
 */

import { createLogger } from '../logging/logger';

const log = createLogger('wakeword.personalization-features');

const CHUNK_SIZE = 1280;      // audio samples per mel chunk
const MEL_OVERLAP = 480;      // overlap with previous chunk
const MEL_BUFFER_SIZE = 76;   // frames needed for embedding model
const MEL_FEATURE_DIM = 32;   // mel spectrogram feature dimension
const EMB_OUTPUT_DIM = 96;    // embedding model output dimension
const EMB_FRAMES = 16;        // embedding frames per pass
const FEATURE_DIM = EMB_FRAMES * EMB_OUTPUT_DIM; // 1536

/**
 * Extract a (1536,) feature vector from a raw audio utterance.
 * @param audio 16kHz mono Float32Array (1-3 seconds)
 * @param melSession ONNX InferenceSession for melspectrogram.onnx
 * @param embSession ONNX InferenceSession for embedding_model.onnx
 * @param ort ONNX Runtime module reference
 * @returns Float32Array of length 1536
 */
export async function extractFeatures(
  audio: Float32Array,
  melSession: any,
  embSession: any,
  ort: any,
): Promise<Float32Array> {
  // Pad or trim to 24000 samples (1.5s at 16kHz)
  const TARGET_LEN = 24000;
  let samples: Float32Array;
  if (audio.length >= TARGET_LEN) {
    samples = audio.slice(0, TARGET_LEN);
  } else {
    samples = new Float32Array(TARGET_LEN);
    samples.set(audio);
  }

  // Process chunks through mel spectrogram model.
  // Matches _owwProcessChunk in wakeword-manager.ts exactly:
  //   - First chunk: 1280 samples (no previous tail)
  //   - Subsequent chunks: 480-sample tail from previous chunk + 1280 fresh samples = 1760 samples
  const allMelFrames: Float32Array[] = [];
  let prevChunkTail: Float32Array | null = null;

  const numChunks = Math.floor(samples.length / CHUNK_SIZE);

  for (let c = 0; c < numChunks; c++) {
    const freshSamples = samples.slice(c * CHUNK_SIZE, (c + 1) * CHUNK_SIZE);

    const hasOverlap = prevChunkTail !== null && prevChunkTail.length === MEL_OVERLAP;
    const melLen = hasOverlap ? MEL_OVERLAP + CHUNK_SIZE : CHUNK_SIZE;
    const melChunk = new Float32Array(melLen);

    let off = 0;
    if (hasOverlap) {
      // Prepend previous chunk tail (scaled to PCM range)
      for (let i = 0; i < MEL_OVERLAP; i++) melChunk[i] = prevChunkTail![i] * 32768.0;
      off = MEL_OVERLAP;
    }
    for (let i = 0; i < CHUNK_SIZE; i++) melChunk[off + i] = freshSamples[i] * 32768.0;

    // Save last 480 samples of this chunk as tail for next iteration
    prevChunkTail = freshSamples.slice(CHUNK_SIZE - MEL_OVERLAP);

    // Run mel spectrogram model
    const melInput = new ort.Tensor('float32', melChunk, [1, melLen]);
    const melResult = await melSession.run({ input: melInput });
    const melOutput = Object.values(melResult)[0] as any;
    const melData = melOutput.data as Float32Array;
    // Mel output shape is (1, 1, nFrames, 32) — frame count is at dims[2]
    const nFrames = melOutput.dims[2]; // typically 5 frames per chunk

    // Extract and normalize mel frames
    const melFeatureSize = melOutput.dims[3]; // should be 32
    for (let f = 0; f < nFrames; f++) {
      const frame = new Float32Array(MEL_FEATURE_DIM);
      for (let j = 0; j < melFeatureSize; j++) {
        // Mandatory normalization matching wakeword-manager.ts line 874
        frame[j] = (melData[f * melFeatureSize + j] / 10.0) + 2.0;
      }
      allMelFrames.push(frame);
    }
  }

  // Take last 76 frames (matching ring buffer behavior)
  const melBuffer: Float32Array[] = [];
  const startIdx = Math.max(0, allMelFrames.length - MEL_BUFFER_SIZE);
  for (let i = startIdx; i < allMelFrames.length; i++) {
    melBuffer.push(allMelFrames[i]);
  }
  // Pad with zeros if fewer than 76 frames
  while (melBuffer.length < MEL_BUFFER_SIZE) {
    melBuffer.unshift(new Float32Array(MEL_FEATURE_DIM));
  }

  // Construct embedding model input: (1, 76, 32, 1)
  const embInputData = new Float32Array(MEL_BUFFER_SIZE * MEL_FEATURE_DIM);
  for (let i = 0; i < MEL_BUFFER_SIZE; i++) {
    embInputData.set(melBuffer[i], i * MEL_FEATURE_DIM);
  }
  const embInput = new ort.Tensor('float32', embInputData, [1, MEL_BUFFER_SIZE, MEL_FEATURE_DIM, 1]);

  // Run embedding model
  // Use dynamic input name (matching wakeword-manager.ts line 885)
  const embInputName = (embSession as { inputNames: string[] }).inputNames[0];
  const embFeeds: Record<string, any> = {};
  embFeeds[embInputName] = embInput;
  const embResult = await embSession.run(embFeeds);
  const embOutput = Object.values(embResult)[0] as any;
  const embData = embOutput.data as Float32Array;

  // Extract 16 × 96 = 1536 features
  const features = new Float32Array(FEATURE_DIM);
  features.set(embData.slice(0, FEATURE_DIM));

  log.info('Extracted features', { audioLen: audio.length, melFrames: allMelFrames.length, featureDim: FEATURE_DIM });

  return features;
}

/**
 * Generate synthetic negative features by processing low-amplitude noise through
 * the mel+embedding pipeline. Used as fallback when negative_features.bin is unavailable.
 *
 * @param count Number of synthetic negative examples to generate
 * @param melSession mel spectrogram ONNX session
 * @param embSession embedding ONNX session
 * @param ort ONNX Runtime module reference
 * @returns Float32Array of shape (count * 1536,)
 */
export async function generateSyntheticNegatives(
  count: number,
  melSession: any,
  embSession: any,
  ort: any,
): Promise<Float32Array> {
  const AUDIO_LEN = 24000; // 1.5s at 16kHz
  const result = new Float32Array(count * FEATURE_DIM);
  for (let i = 0; i < count; i++) {
    // Low-amplitude noise representing ambient/silence (clearly not a keyword)
    const noise = new Float32Array(AUDIO_LEN);
    for (let j = 0; j < AUDIO_LEN; j++) {
      noise[j] = (Math.random() * 2 - 1) * 0.008;
    }
    const features = await extractFeatures(noise, melSession, embSession, ort);
    result.set(features, i * FEATURE_DIM);
  }
  log.info('Generated synthetic negatives', { count, featureDim: FEATURE_DIM });
  return result;
}

/**
 * Extract features for multiple utterances of a keyword.
 * @param utterances Array of raw audio buffers (16kHz mono)
 * @param melSession mel spectrogram ONNX session
 * @param embSession embedding ONNX session
 * @param ort ONNX Runtime module reference
 * @returns Array of Float32Array(1536), one per utterance
 */
export async function extractBatchFeatures(
  utterances: Float32Array[],
  melSession: any,
  embSession: any,
  ort: any,
): Promise<Float32Array[]> {
  const results: Float32Array[] = [];
  for (const audio of utterances) {
    results.push(await extractFeatures(audio, melSession, embSession, ort));
  }
  return results;
}
