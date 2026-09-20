import type { NextConfig } from 'next';

const config: NextConfig = {
  // The shared packages ship TypeScript source rather than built JS, so Next
  // has to compile them the way it compiles the app.
  transpilePackages: ['@dtwin/db', '@dtwin/types'],
  // `pg` opens TCP sockets and loads native bindings; bundling it breaks both.
  serverExternalPackages: ['pg'],
  typescript: { ignoreBuildErrors: false },
  // Ship only what the server actually needs. Without this the image carries
  // the whole build toolchain and every dev dependency — Next traces the
  // imports instead and copies the closure, including the transpiled workspace
  // packages above.
  output: 'standalone',
  // The workspace root, not apps/web: tracing has to reach node_modules and
  // packages/* which live two levels up, and Next warns and guesses otherwise.
  outputFileTracingRoot: new URL('../..', import.meta.url).pathname,
};

export default config;
