import type { NextConfig } from 'next';

const config: NextConfig = {
  // The shared packages ship TypeScript source rather than built JS, so Next
  // has to compile them the way it compiles the app.
  transpilePackages: ['@dtwin/db', '@dtwin/types'],
  // `pg` opens TCP sockets and loads native bindings; bundling it breaks both.
  serverExternalPackages: ['pg'],
  typescript: { ignoreBuildErrors: false },
};

export default config;
