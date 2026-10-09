/**
 * Labels the local OWL-ViT server is asked about (keep in sync with
 * `vendor/yolo_server.py`) and the wording used in the transparency report.
 * "person" is queried only for context and is never flagged.
 */
const FRIENDLY_NAMES: Readonly<Record<string, string>> = {
  'cell phone': 'mobile phone',
  earbuds: 'earbuds',
  headphones: 'headphones',
  headset: 'headset',
  'smart glasses': 'smart glasses',
  'smart watch': 'smartwatch',
};

/** Flag names are stored as `flag:vision_<label with underscores>`. */
export function visionFlagName(label: string): string {
  return `vision_${label.replaceAll(' ', '_')}`;
}

export function isFlaggableVisionLabel(label: string): boolean {
  return Object.hasOwn(FRIENDLY_NAMES, label);
}

/** Friendly name for a label or its underscore slug; unknown labels are shown as-is. */
export function friendlyVisionLabel(labelOrSlug: string): string {
  const label = labelOrSlug.replaceAll('_', ' ');
  return Object.hasOwn(FRIENDLY_NAMES, label) ? FRIENDLY_NAMES[label]! : label;
}
