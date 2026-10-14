"""
Train a civic-issue image classifier (TensorFlow/Keras) and export it for the browser (TF.js).

Dataset layout (one folder per category id used in js/config.js):
    ml/dataset/garbage/*.jpg
    ml/dataset/pothole/*.jpg
    ml/dataset/road/*.jpg
    ml/dataset/streetlight/*.jpg
    ml/dataset/drainage/*.jpg
    ml/dataset/water/*.jpg
    ml/dataset/other/*.jpg     (optional catch-all)
Aim for 150+ varied photos per class (different lighting, distances, cities).

Run:
    pip install tensorflow tensorflowjs
    python ml/train.py
Output goes to ../model/ (model.json, weight shards, labels.json) – commit and redeploy.
"""
import json, pathlib, subprocess, sys
import tensorflow as tf

ROOT = pathlib.Path(__file__).parent
DATA = ROOT / "dataset"
OUT = ROOT.parent / "model"
IMG = (224, 224)
BATCH = 32

if not DATA.exists():
    sys.exit(f"Dataset folder not found: {DATA}. See the docstring at the top of this file.")

train = tf.keras.utils.image_dataset_from_directory(
    DATA, validation_split=0.2, subset="training", seed=42, image_size=IMG, batch_size=BATCH)
val = tf.keras.utils.image_dataset_from_directory(
    DATA, validation_split=0.2, subset="validation", seed=42, image_size=IMG, batch_size=BATCH)
labels = train.class_names
print("Classes:", labels)

AUTOTUNE = tf.data.AUTOTUNE
train = train.cache().shuffle(1000).prefetch(AUTOTUNE)
val = val.cache().prefetch(AUTOTUNE)

augment = tf.keras.Sequential([
    tf.keras.layers.RandomFlip("horizontal"),
    tf.keras.layers.RandomRotation(0.08),
    tf.keras.layers.RandomZoom(0.15),
    tf.keras.layers.RandomContrast(0.2),
])

base = tf.keras.applications.MobileNetV2(input_shape=IMG + (3,), include_top=False, weights="imagenet")
base.trainable = False

inputs = tf.keras.Input(shape=IMG + (3,))
x = augment(inputs)
x = tf.keras.layers.Rescaling(1 / 127.5, offset=-1)(x)   # same preprocessing as js/ai.js: (pixel/127.5) - 1
x = base(x, training=False)
x = tf.keras.layers.GlobalAveragePooling2D()(x)
x = tf.keras.layers.Dropout(0.3)(x)
outputs = tf.keras.layers.Dense(len(labels), activation="softmax")(x)
model = tf.keras.Model(inputs, outputs)

model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
model.fit(train, validation_data=val, epochs=8)

# Fine-tune the top of the backbone
base.trainable = True
for layer in base.layers[:-30]:
    layer.trainable = False
model.compile(optimizer=tf.keras.optimizers.Adam(1e-5), loss="sparse_categorical_crossentropy", metrics=["accuracy"])
model.fit(train, validation_data=val, epochs=6)

loss, acc = model.evaluate(val)
print(f"Validation accuracy: {acc:.1%}")

model.save(ROOT / "civic_model.keras")
OUT.mkdir(exist_ok=True)
for old in OUT.glob("*"):
    if old.name != "README.md":
        old.unlink()
subprocess.run([
    "tensorflowjs_converter", "--input_format=keras",
    str(ROOT / "civic_model.keras"), str(OUT)], check=True)
(OUT / "labels.json").write_text(json.dumps(labels))
print(f"Exported TF.js model and labels.json to {OUT}")
