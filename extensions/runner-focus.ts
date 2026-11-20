import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getJob } from '../src/store.mjs';
import { registerInheritedFocus } from '../src/focus-runtime.mjs';

export default async function extension(pi: ExtensionAPI): Promise<void> {
  // Pi normally reports extension errors and continues. This dedicated worker
  // adapter must instead stop before a model runs with a missing focus binding.
  const fatal = (error: unknown): never => {
    console.error(`pi-wrk focus initialization failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  };
  try {
    const dir = process.env.PI_WRK_STORE;
    const id = process.env.PI_WRK_JOB_ID;
    if (!dir || !id) throw new Error('worker job environment required');
    await registerInheritedFocus(pi, getJob(dir, id).focus, { onStartupError: fatal });
  } catch (error) { fatal(error); }
}
