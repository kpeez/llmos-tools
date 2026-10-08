---
categories:
  - "[[Sources]]"
converter: defuddle@0.19.4
created: 2026-10-08
figures: 0
licence: not stated
origin: https://example.org/example-study-v1
retrieved: 2026-10-08
sha256_text: fc0a36c410f9e68dcb59c18c8d54f58fbda863a41c0ba64ef852411b3c1e4f62
source_id: web:https://example.org/example-study-v1
---

# Face Recognition in Captive Primates

Ada Example Affiliation: Example Institute

###### Abstract

We study face recognition in captive primates and report a closed-set baseline.

## Dataset

The dataset contains 6,280 face images of 34 individuals, collected between 2015 and 2017 at one facility. Images were taken at a ﬁxed distance with a handheld camera.[^1]

### Splits

We use 5-fold cross-validation and keep all images of one individual in one fold.

## Results

The ResNet-50 baseline reaches 94.7 % top-1 accuracy on the closed‑set protocol, with a spread of ± 0.5 across folds. A DINOv2 backbone reaches 96.3\% top-1, and about $1.3$ hours of video were used for tuning. The “open set” protocol is harder.

## Chimpanzee table

| Method | Closed set | Open set | Verification | Rank-5 |
| --- | --- | --- | --- | --- |
| ResNet-18+Cross Entropy | 97.97 $\pm$ 0.70 | 96.52 $\pm$ 1.95 | 98.08 $\pm$ 0.45 | 92.72 $\pm$ 2.45 |

## Figures

Figure 1: Example images.

[^1]: Ada Example. 2018. Notes on capture. Example Journal 4(2):10–20.
