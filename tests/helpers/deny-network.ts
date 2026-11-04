// Explicit test-process preload: authentication errors must not depend on the
// live skills repository remaining private, or on the caller's GitHub token.
delete process.env.DITTOSH_SKILLS_TARBALL;
globalThis.fetch = async (input) =>
  new Response("{}", {
    status: String(input).includes("registry.npmjs.org") ? 404 : 401,
  });

export {};
