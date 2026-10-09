import sys
import json
import base64
from io import BytesIO
from PIL import Image

try:
    # Use OWL-ViT for zero-shot text-based detection, allowing us to query "earbuds" natively!
    from transformers import pipeline
    print("Loading OWL-ViT massive vision model...", file=sys.stderr)
    detector = pipeline(model="google/owlvit-base-patch32", task="zero-shot-object-detection")
    print("READY", file=sys.stderr)
except ImportError:
    print("Transformers not installed. Run: pip install transformers Pillow torch", file=sys.stderr)
    sys.exit(1)

CANDIDATE_LABELS = [
    "cell phone",
    "earbuds",
    "headphones",
    "headset",
    "smart glasses",
    "smart watch",
    "person",
]

# Default minimum score, with optional per-label overrides. Small items at webcam
# resolution score low, so tune e.g. {"earbuds": 0.25} here after testing on real frames.
DEFAULT_THRESHOLD = 0.4
LABEL_THRESHOLDS = {
    # "earbuds": 0.4,
    # "smart watch": 0.4,
}


def keep(prediction):
    return prediction["score"] > LABEL_THRESHOLDS.get(prediction["label"], DEFAULT_THRESHOLD)


# Listen for base64 images on stdin
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    
    try:
        req = json.loads(line)
        image_data = base64.b64decode(req["image_base64"])
        image = Image.open(BytesIO(image_data)).convert("RGB")
        
        # Query the massive model for our specific threat vectors
        predictions = detector(
            image,
            candidate_labels=CANDIDATE_LABELS,
        )
        
        # Filter high confidence threats
        threats = [p for p in predictions if keep(p)]
        
        print(json.dumps({"status": "ok", "detections": threats}))
        sys.stdout.flush()
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.stdout.flush()
