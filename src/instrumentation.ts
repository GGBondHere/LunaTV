export async function register() {
  // Next also loads instrumentation in build workers; those must never touch storage.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build' &&
    process.env.NODE_ENV === 'production'
  ) {
    // Keep loading behind the runtime guard, using Node16 CommonJS resolution.
    const { startMediaRuntime } =
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('@/lib/media.server') as typeof import('@/lib/media.server');
    void startMediaRuntime();
  }
}
