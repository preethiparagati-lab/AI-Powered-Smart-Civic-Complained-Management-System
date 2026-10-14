# Custom model folder

Empty by default: the app then uses generic MobileNetV2 with keyword matching (rough).
After running `python ml/train.py`, this folder will contain `model.json`, weight files and `labels.json`.
Commit them and redeploy – the app detects and uses them automatically.
