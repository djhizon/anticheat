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
            candidate_labels=["cell phone", "earbuds", "headphones", "smart glasses", "person"],
        )
        
        # Filter high confidence threats
        threats = [p for p in predictions if p["score"] > 0.4]
        
        print(json.dumps({"status": "ok", "detections": threats}))
        sys.stdout.flush()
    except Exception as e:
        print(json.dumps({"status": "error", "message": str(e)}))
        sys.stdout.flush()
