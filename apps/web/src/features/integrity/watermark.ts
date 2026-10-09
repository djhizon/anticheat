export function embedWatermark(text: string, attemptId: string): string {
  if (!text) return text;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(attemptId);
  let binaryString = '';
  for (const byte of bytes) {
    binaryString += byte.toString(2).padStart(8, '0');
  }

  let watermark = '';
  for (let i = 0; i < binaryString.length; i++) {
    watermark += binaryString[i] === '0' ? '\u200B' : '\u200C';
  }

  return text + watermark;
}
