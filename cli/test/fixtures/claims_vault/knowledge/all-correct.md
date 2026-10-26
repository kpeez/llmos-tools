---
status: active
created: 2026-10-08
---

# Example primate faces

The numbers below come from the [[raw/example-study-v1/source|example study]] and the [[raw/second-study-v1/source|second study]].

> [!fact] drafted
> The example dataset holds 6280 face images of 34 individuals.
> > "The dataset contains 6,280 face images of 34 individuals"
> — [[raw/example-study-v1/source#Dataset|Example study, Dataset]]

^fact-dataset-size

> [!fact] checked
> The ResNet-50 baseline reaches 94.7% top-1 accuracy on the closed-set protocol, with ±0.5 across folds.
> > "The ResNet-50 baseline reaches 94.7 % top-1 accuracy on the closed-set protocol, with a spread of ± 0.5 across folds"
> — [[raw/example-study-v1/source#Results|Example study, Results]]

^fact-baseline-accuracy

> [!fact] verified
> The dataset holds 6,280 images, all from a single facility.
> > "The dataset contains 6,280 face images […] at one facility"
> — [[raw/example-study-v1/source#Dataset|Example study, Dataset]]

^fact-one-facility

> [!fact] checked
> The study uses 5-fold cross-validation (Example, 2018).
> > "We use 5-fold cross-validation and keep all images of one individual in one fold"
> — [[raw/example-study-v1/source#Dataset|Example study, Dataset]]

^fact-cross-validation

> [!fact] checked
> ResNet-18 trained with cross entropy reaches 97.97 ± 0.70 in the closed-set test.
> > "ResNet-18+Cross Entropy | 97.97 $\pm$ 0.70 | 96.52 $\pm$ 1.95 | 98.08 $\pm$ 0.45"
> — [[raw/example-study-v1/source#Chimpanzee table|Example study, table]]

^fact-chimpanzee-row

> [!fact] superseded
> The example dataset holds 6,100 face images.
> > "The dataset contains 6,100 face images"
> — [[raw/example-study-v1/source#Dataset|Example study, Dataset]]

^fact-old-dataset-size

> [!fact] flagged: source not captured
> A third study reports 96.3% top-1.
> — Third 2026, doi:10.0000/example.0001

> [!conflict] open
> The studies disagree on the image count: 6,280 or 6,380.
> > "The dataset contains 6,280 face images of 34 individuals"
> — [[raw/example-study-v1/source#Dataset|Example study, Dataset]]
> > "Our dataset contains 6,380 face images of 34 individuals."
> — [[raw/second-study-v1/source#Data|Second study, Data]]

^conflict-image-count
