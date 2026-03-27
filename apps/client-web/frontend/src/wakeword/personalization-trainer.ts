/**
 * In-browser wakeword classifier fine-tuning using TensorFlow.js.
 *
 * Loads weights from ONNX format, trains with user samples + negatives,
 * exports weights back to ONNX-compatible format for hot-swap.
 */

import { createLogger } from '../logging/logger';

const log = createLogger('wakeword.personalization-trainer');

const FEATURE_DIM = 1536;
const HIDDEN_DIM = 64;

export interface TrainProgress {
  phase: 'loading' | 'training' | 'exporting';
  keyword: string;
  epoch?: number;
  totalEpochs?: number;
  loss?: number;
}

export type ProgressCallback = (progress: TrainProgress) => void;

/**
 * Build TF.js model matching the PyTorch classifier architecture.
 */
function buildModel(tf: any): any {
  const model = tf.sequential();

  // Layer 0: Dense(1536 → 64) + ReLU
  model.add(tf.layers.dense({ inputShape: [FEATURE_DIM], units: HIDDEN_DIM, activation: 'relu' }));
  // Layer 1: LayerNormalization
  model.add(tf.layers.layerNormalization());

  // Layer 2: Dense(64 → 64) + ReLU
  model.add(tf.layers.dense({ units: HIDDEN_DIM, activation: 'relu' }));
  // Layer 3: LayerNormalization
  model.add(tf.layers.layerNormalization());

  // Layer 4: Dense(64 → 64) + ReLU
  model.add(tf.layers.dense({ units: HIDDEN_DIM, activation: 'relu' }));
  // Layer 5: LayerNormalization
  model.add(tf.layers.layerNormalization());

  // Layer 6: Dense(64 → 1) + Sigmoid
  model.add(tf.layers.dense({ units: 1, activation: 'sigmoid' }));

  return model;
}

/**
 * Load ONNX weights into the TF.js model.
 *
 * The ONNX model has weights split between:
 * 1. .onnx.data file (3 large weight matrices, raw float32)
 * 2. .onnx protobuf (biases + LayerNorm params, inline)
 *
 * The approach used here: fetch the .onnx.data for the 3 weight
 * matrices, and use the model's default initialization for biases
 * and LayerNorm (which are small and will be retrained anyway).
 *
 * TODO: Generate weight manifests at deploy time for exact weight loading.
 */
async function loadOnnxWeights(
  tf: any,
  model: any,
  onnxDataUrl: string,
): Promise<void> {
  // Fetch the .onnx.data file (contains 3 weight matrices).
  // If unavailable (e.g. OWW-official models without separate weights),
  // fall back to TF.js default random initialization and log a warning.
  const response = await fetch(onnxDataUrl);
  if (!response.ok) {
    log.warn('Could not load .onnx.data weights, training from random init', {
      url: onnxDataUrl,
      status: response.status,
    });
    return; // model keeps default random weights
  }
  const buffer = await response.arrayBuffer();
  const data = new Float32Array(buffer);

  // .onnx.data layout:
  // Offset 0:     layers[3].weight (64×64)    = 4096 floats
  // Offset 4096:  layers[6].weight (64×64)    = 4096 floats
  // Offset 8192:  layers[0].weight (64×1536)  = 98304 floats

  const w3 = data.slice(0, 4096);           // Linear(64→64) layer index 3
  const w6 = data.slice(4096, 8192);        // Linear(64→64) layer index 6
  const w0 = data.slice(8192, 8192 + 98304); // Linear(1536→64) layer index 0

  // TF.js layer indices in our Sequential model:
  // 0: dense (1536→64)    — corresponds to PyTorch layer 0
  // 1: layerNorm          — corresponds to PyTorch layer 2
  // 2: dense (64→64)      — corresponds to PyTorch layer 3
  // 3: layerNorm          — corresponds to PyTorch layer 5
  // 4: dense (64→64)      — corresponds to PyTorch layer 6
  // 5: layerNorm          — corresponds to PyTorch layer 8
  // 6: dense (64→1)       — corresponds to PyTorch layer 9

  const layers = model.layers;

  // Dense layer 0 (1536→64): PyTorch stores (64, 1536), TF.js needs (1536, 64)
  const kernel0 = transpose2d(tf, w0, 64, 1536);
  layers[0].setWeights([kernel0, layers[0].getWeights()[1]]); // keep existing bias

  // Dense layer 2 (64→64): PyTorch stores (64, 64), TF.js needs (64, 64) — symmetric, but transpose anyway
  const kernel2 = transpose2d(tf, w3, 64, 64);
  layers[2].setWeights([kernel2, layers[2].getWeights()[1]]);

  // Dense layer 4 (64→64)
  const kernel4 = transpose2d(tf, w6, 64, 64);
  layers[4].setWeights([kernel4, layers[4].getWeights()[1]]);

  // Note: LayerNorm weights and biases, Dense biases, and final Dense(64→1)
  // are NOT in the .onnx.data file. They remain at TF.js default init.
  // Fine-tuning will adjust all weights including these.

  log.info('Loaded ONNX weights from .data file', { dataSize: data.length });
}

/**
 * Transpose a (rows, cols) PyTorch weight matrix to (cols, rows) for TF.js.
 */
function transpose2d(tf: any, data: Float32Array, rows: number, cols: number): any {
  const tensor = tf.tensor2d(data, [rows, cols]);
  const transposed = tensor.transpose();
  tensor.dispose();
  return transposed;
}

/**
 * Export model weights back to ONNX .data format.
 * Returns an ArrayBuffer matching the original .onnx.data layout.
 */
async function exportWeights(tf: any, model: any): Promise<ArrayBuffer> {
  const layers = model.layers;

  // Extract and transpose kernels back to PyTorch format (out, in)
  // Dispose all intermediate tensors to avoid memory leaks.
  const k0 = layers[0].getWeights()[0]; // (1536, 64) → transpose to (64, 1536)
  const k2 = layers[2].getWeights()[0]; // (64, 64)
  const k4 = layers[4].getWeights()[0]; // (64, 64)

  const k0T = k0.transpose();
  const w0 = await k0T.data(); // (64, 1536) = 98304 floats
  k0.dispose(); k0T.dispose();

  const k2T = k2.transpose();
  const w3 = await k2T.data(); // (64, 64) = 4096 floats
  k2.dispose(); k2T.dispose();

  const k4T = k4.transpose();
  const w6 = await k4T.data(); // (64, 64) = 4096 floats
  k4.dispose(); k4T.dispose();

  // Reconstruct .onnx.data layout: [w3, w6, w0]
  const totalSize = 4096 + 4096 + 98304;
  const output = new Float32Array(totalSize);
  output.set(w3, 0);
  output.set(w6, 4096);
  output.set(w0, 8192);

  log.info('Exported weights', { totalParams: totalSize });

  return output.buffer;
}

/**
 * Fine-tune a keyword classifier with user recordings.
 *
 * @param keyword Keyword name
 * @param positiveFeatures User's feature vectors (5, 1536)
 * @param negativeFeatures Pre-packaged negative features (2000, 1536)
 * @param onnxDataUrl URL to fetch current .onnx.data weights
 * @param onProgress Progress callback
 * @returns ArrayBuffer of updated .onnx.data weights
 */
export async function trainKeyword(
  keyword: string,
  positiveFeatures: Float32Array[],
  negativeFeatures: Float32Array,
  onnxDataUrl: string,
  onProgress?: ProgressCallback,
): Promise<ArrayBuffer> {
  const tf = await import('@tensorflow/tfjs');

  onProgress?.({ phase: 'loading', keyword });

  // Build model and load current weights
  const model = buildModel(tf);
  await loadOnnxWeights(tf, model, onnxDataUrl);

  // Compile
  model.compile({
    optimizer: tf.train.adam(0.001),
    loss: 'binaryCrossentropy',
  });

  // Prepare training data
  const nPositive = positiveFeatures.length;
  const nNegative = negativeFeatures.length / FEATURE_DIM;
  if (!Number.isInteger(nNegative) || nNegative === 0) {
    throw new Error(`Invalid negative features: length=${negativeFeatures.length}, expected multiple of ${FEATURE_DIM}`);
  }
  const totalSamples = nPositive + nNegative;

  // Combine features
  const xData = new Float32Array(totalSamples * FEATURE_DIM);
  for (let i = 0; i < nPositive; i++) {
    xData.set(positiveFeatures[i], i * FEATURE_DIM);
  }
  xData.set(negativeFeatures, nPositive * FEATURE_DIM);

  // Labels: 1 for positive, 0 for negative
  const yData = new Float32Array(totalSamples);
  for (let i = 0; i < nPositive; i++) yData[i] = 1.0;
  // negatives already 0.0

  // Sample weights: 5.0 for positive (match v3 training bias), 1.0 for negative
  const wData = new Float32Array(totalSamples);
  for (let i = 0; i < nPositive; i++) wData[i] = 5.0;
  for (let i = nPositive; i < totalSamples; i++) wData[i] = 1.0;

  const xs = tf.tensor2d(xData, [totalSamples, FEATURE_DIM]);
  const ys = tf.tensor2d(yData, [totalSamples, 1]);
  const ws = tf.tensor1d(wData);

  // Train
  const EPOCHS = 10;
  const BATCH_SIZE = 256;

  onProgress?.({ phase: 'training', keyword, epoch: 0, totalEpochs: EPOCHS });

  await model.fit(xs, ys, {
    epochs: EPOCHS,
    batchSize: BATCH_SIZE,
    sampleWeight: ws,
    shuffle: true,
    callbacks: {
      onEpochEnd: (epoch: number, logs: any) => {
        const loss = logs?.loss ?? 0;
        log.info('Training epoch', { keyword, epoch: epoch + 1, loss });
        onProgress?.({ phase: 'training', keyword, epoch: epoch + 1, totalEpochs: EPOCHS, loss });
      },
    },
  });

  // Export weights
  onProgress?.({ phase: 'exporting', keyword });
  const weightsBuffer = await exportWeights(tf, model);

  // Cleanup
  xs.dispose();
  ys.dispose();
  ws.dispose();
  model.dispose();

  return weightsBuffer;
}

/**
 * Load the pre-packaged negative feature bundle.
 * @param url URL to negative_features.bin
 * @returns Float32Array of shape (2000 * 1536,)
 */
export async function loadNegativeFeatures(url: string): Promise<Float32Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
  }
  const buffer = await response.arrayBuffer();
  return new Float32Array(buffer);
}
