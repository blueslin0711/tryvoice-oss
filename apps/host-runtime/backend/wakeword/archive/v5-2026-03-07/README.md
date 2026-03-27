# Wake Word v5 Archive — 2026-03-07

## Pipeline vs v3/v4

| Stage | v3 | v4 | v5 |
|-------|----|----|-----|
| Real speech source | 28-aug variants | 28-aug variants | **pitch×4 + aug×5 = 500 samples** |
| Real speech weight | **5x** | 1x | 1x |
| Pipeline | TTS→retrain | TTS→retrain (same features) | TTS + fresh real features |

**v5 = proper mix**: real speech goes through the SAME pitch shift + RIR augmentation
pipeline as TTS, then combined at equal weight (1x).

## Real Speech Feature Pipeline (new in v5)

```
WAV files (20-21 per word)
  → pitch shift ×4 (-2,-1,+1,+2 semitones) + originals = 5 variants × 20 = 100 WAVs
  → RIR convolution + noise augmentation ×5 = 500 WAVs
  → OWW mel spectrogram + embedding extraction
  → features_positive/{word}_real_v5.npy  shape=(500, 16, 96)
```

## Results

| Word | v5 Loss | v4 Loss | v3 Loss | v5 Samples | Notes |
|------|---------|---------|---------|------------|-------|
| americano | 0.000000 | 0.000000 | 0.000000 | 500 | |
| snowboy | 0.000000 | 0.000000 | 0.000000 | 500 | Early stop @36500 |
| terminator | 0.000000 | 0.000021 | 0.000000 | 500 | Early stop @40500 |
| bumblebee | 0.000000 | 0.000000 | 0.000000 | 500 | Early stop @38500 |
| jarvis | 0.000006 | 0.000000 | 0.000042 | 500 | Early stop @15500 |
| grasshopper | 0.000000 | 0.000001 | 0.000000 | 500 | Early stop @34500 |
| haichuanchuan | 0.000308 | 0.000108 | 0.000282 | 525 | Early stop @14000 |
| woshuohaole | 0.000065 | 0.000000 | 0.000000 | 500 | Early stop @10000 |
| quxiaoquxiao | 0.000009 | 0.000000 | 0.000008 | 525 | Early stop @11500 |

## Observations

- Total training time: ~8 min (feature prep ~1min/word + train ~30s/word)
- haichuanchuan v5 loss (0.000308) slightly higher than v4 (0.000108)
  → real speech features with pitch augmentation may be harder to fit
- woshuohaole v5 loss (0.000065) higher than v4 (0)
  → similar reason; classifier may need more steps with diverse real speech
- These higher losses may actually indicate BETTER generalization

## Comparison Plan

Deploy all three versions for live A/B test:
- v3: archive/v3-2026-03-07/ — 5x weight, biased to recorder
- v4: archive/v4-2026-03-07/ — 1x weight, same features as v3
- v5: archive/v5-2026-03-07/ — 1x weight, pitch+aug enriched features  ← this version

## Remote Training

- IP: 192.168.68.63 / WSL: aaronz
- Features: /home/aaronz/wake-word-trainer/data/features_positive/{word}_real_v5.npy
- Models: /home/aaronz/wake-word-trainer/models/{word}_v5/
