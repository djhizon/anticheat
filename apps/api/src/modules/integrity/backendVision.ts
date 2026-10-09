import { spawn, type ChildProcess } from 'child_process';
import { join } from 'path';

let pyProcess: ChildProcess | null = null;
let currentResolve: ((value: any) => void) | null = null;
let currentReject: ((reason?: any) => void) | null = null;
let stdoutBuffer = '';

export function startVisionServer() {
  if (pyProcess) return;
  const scriptPath = join(process.cwd(), 'vendor', 'yolo_server.py');
  
  pyProcess = spawn('python3', [scriptPath]);
  
  pyProcess.stdout?.on('data', (data) => {
    // stdout chunks can split or merge JSON lines, so buffer until a newline.
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      try {
        const result = JSON.parse(line);
        if (currentResolve) {
          currentResolve(result);
          currentResolve = null;
          currentReject = null;
        }
      } catch (e) {
        console.error('Failed to parse vision server output:', line);
      }
    }
  });

  pyProcess.stderr?.on('data', (data) => {
    console.log('[OWL-ViT]', data.toString().trim());
  });
}

export async function detectObjectsRemotely(imageBase64: string): Promise<any> {
  if (!pyProcess) startVisionServer();
  
  return new Promise((resolve, reject) => {
    if (currentReject) {
      currentReject(new Error('Overlapped vision request'));
    }
    currentResolve = resolve;
    currentReject = reject;
    
    const payload = JSON.stringify({ image_base64: imageBase64 }) + '\n';
    pyProcess?.stdin?.write(payload);
  });
}
